-- Shared, in-memory snapshot for the single Caddy instance managed by this plugin.
local apply = require("apply")
local caddy = require("caddy")
local settings = require("settings")
local util = require("util")

local M = {}
local PERIOD, EXPIRES, MIN_AGE = 60, 90, 10
local OUTPUT_LIMIT = 64 * 1024
local cache, scheduled

local runtimeNames = {
  go_goroutines = "goroutines",
  go_memstats_heap_alloc_bytes = "heapBytes",
  process_resident_memory_bytes = "rssBytes",
  process_cpu_seconds_total = "cpuSeconds",
  process_start_time_seconds = "startedAt",
}

local function labelsOf(text)
  local labels = {}
  for key, value in text:gmatch('([%w_]+)="([^"]*)"') do labels[key] = value end
  return labels
end

local function parse(raw)
  local runtime, handlers, upstreams = {}, {}, {}
  for line in raw:gmatch("[^\r\n]+") do
    local name, tail = line:match("^([%a_][%w_:]*)%s*(.+)$")
    local number = tail and tonumber(tail:match("%s+(%S+)%s*$") or tail)
    if number and number >= 0 and number < math.huge then
      local runtimeKey = runtimeNames[name]
      if runtimeKey then
        runtime[runtimeKey] = number
      elseif name == "caddy_reverse_proxy_upstreams_healthy" then
        local address = labelsOf(tail).upstream
        if address and #address <= 256 and (number == 0 or number == 1) then
          if number == 0 or not upstreams[address] then
            upstreams[address] = number == 0 and "unhealthy" or "unverified"
          end
        end
      elseif name == "caddy_http_requests_total" or name == "caddy_http_request_errors_total"
        or name == "caddy_http_request_duration_seconds_sum" or name == "caddy_http_request_duration_seconds_count" then
        local labels = labelsOf(tail)
        local server, handler = labels.server, labels.handler
        if server and handler and #server <= 128 and #handler <= 128 then
          local key = #server .. ":" .. server .. handler
          local row = handlers[key] or { server = server, handler = handler, responses = 0, durationSeconds = 0, http5xx = 0 }
          handlers[key] = row
          if name == "caddy_http_requests_total" then
            row.requests = (row.requests or 0) + number
          elseif name == "caddy_http_request_errors_total" then
            row.errors = (row.errors or 0) + number
          elseif name == "caddy_http_request_duration_seconds_sum" then
            row.durationSeconds = row.durationSeconds + number
          elseif name == "caddy_http_request_duration_seconds_count" then
            row.hasResponses = true
            row.responses = row.responses + number
            if labels.code and labels.code:match("^5%d%d$") then row.http5xx = row.http5xx + number end
          end
        end
      end
    end
  end
  local rows, health = util.array({}), util.array({})
  for _, row in pairs(handlers) do
    if row.responses > 0 then row.meanMs = row.durationSeconds / row.responses * 1000 end
    if not row.hasResponses then row.http5xx = nil end
    row.hasResponses, row.responses, row.durationSeconds = nil, nil, nil
    rows[#rows + 1] = row
  end
  table.sort(rows, function(a, b)
    if a.server == b.server then return a.handler < b.handler end
    return a.server < b.server
  end)
  for address, state in pairs(upstreams) do health[#health + 1] = { address = address, status = state } end
  table.sort(health, function(a, b) return a.address < b.address end)
  return runtime, rows, health
end

local function collect(address)
  if not address or address == "off" then
    return { status = "unavailable", message = "本机 Admin API 已关闭或主配置不可读。" }
  end
  local endpoint, localArgs = caddy.localAdminEndpoint(address)
  if not endpoint then
    return { status = "unavailable", message = "Metrics 需要本机回环或 Unix socket 的 Admin API。" }
  end
  local args = { "-q", "--silent", "--show-error", "--fail", "--noproxy", "*", "--globoff",
    "--proto", "=http", "--connect-timeout", "1", "--max-time", "2", "--max-filesize", tostring(OUTPUT_LIMIT) }
  for _, value in ipairs(localArgs) do args[#args + 1] = value end
  args[#args + 1] = endpoint .. "/metrics"
  local ok, response = pcall(host.process.exec, "curl", args, { timeoutMs = 2500 })
  if not ok or not response then
    return { status = "unavailable", message = "无法执行 curl。请检查宿主环境。" }
  end
  if response.stdoutTruncated or response.exitCode == 63 then
    return { status = "truncated", message = "Metrics 超过 64 KiB 上限，本次未汇总。请检查 per_host 和指标规模。" }
  end
  if response.timedOut or response.exitCode == 7 or response.exitCode == 28 or response.exitCode == 52 or response.exitCode == 56 then
    return { status = "unreachable", message = "本机 Admin API 无响应。请检查 Caddy 运行状态和 Admin 地址。" }
  end
  if response.exitCode ~= 0 or response.error then
    return { status = "unavailable", message = "Admin API 未提供可用的 Metrics。请检查运行实例与配置。" }
  end
  local runtime, handlers, upstreams = parse(response.stdout or "")
  if not next(runtime) and #handlers == 0 and #upstreams == 0 then
    return { status = "unavailable", message = "响应中没有可识别的 Caddy Metrics。请检查 Caddy 配置和版本。" }
  end
  return { status = "ok", runtime = runtime, handlers = handlers, upstreams = upstreams }
end

local function snapshot(config, refresh)
  local address = apply.adminAddress(config)
  local now = util.nowEpoch()
  if cache and (cache.address ~= address or cache.path ~= config.mainConfig or now < cache.at) then cache = nil end
  if refresh and (not cache or now - cache.at >= MIN_AGE) then
    local result = collect(address)
    result.checkedAt = util.nowUTC()
    cache = { address = address, path = config.mainConfig, at = util.nowEpoch(), result = result }
    now = cache.at
  end
  if not cache then return { status = "uncollected" } end
  local result = {}
  for key, value in pairs(cache.result) do result[key] = value end
  result.expiresIn = math.max(0, EXPIRES - (now - cache.at))
  if result.expiresIn == 0 then
    result.previousStatus = result.status
    result.status = "expired"
  end
  return result
end

function M.schedule(config)
  if config.metricsPeriodic and not scheduled then
    local ok, registered = pcall(host.schedule.register, "metrics-snapshot", "@every " .. PERIOD .. "s", function()
      local current = settings.load()
      if current.metricsPeriodic then snapshot(current, true) else M.schedule(current) end
    end)
    scheduled = ok and registered == true
  elseif not config.metricsPeriodic and scheduled then
    local ok, removed = pcall(host.schedule.unregister, "metrics-snapshot")
    if ok and removed then scheduled = false end
  end
end

function M.get(config, refresh)
  M.schedule(config)
  local result = snapshot(config, refresh)
  result.periodSeconds = scheduled and PERIOD or nil
  result.scheduleUnavailable = config.metricsPeriodic and not scheduled or nil
  return result
end

return M
