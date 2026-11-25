-- journald and Caddy access-log parsing, filtering and export.
local util = require("util")
local services = require("services")
local sites = require("sites")

local M = {}

local function clip(value, limit)
  local text = type(value) == "string" and value or ""
  if #text > limit then return text:sub(1, limit) .. "…" end
  return text
end

local function stringOrEmpty(v, limit)
  if type(v) == "string" then return clip(v, limit or 4096) end
  return ""
end

-- Parse one journalctl -o short-iso line into {time, message}.
function M.parseJournalLine(line)
  if type(line) ~= "string" then return { time = "", message = "" } end
  line = line:gsub("\r$", "")
  local first, rest = line:match("^(%S+)%s+(.*)$")
  if not first then
    return { time = line, message = line }
  end
  local pos = rest:find("]:", 1, true)
  if pos then
    local message = rest:sub(pos + 2)
    if message:sub(1, 1) == " " then message = message:sub(2) end
    return { time = first, message = message }
  end
  return { time = first, message = rest }
end

local function firstHeaderValue(headers)
  if type(headers) ~= "table" then return "" end
  for key, value in pairs(headers) do
    if type(key) == "string" and util.lower(key) == "user-agent" then
      if type(value) == "string" then return value end
      if type(value) == "table" and type(value[1]) == "string" then return value[1] end
    end
  end
  return ""
end

-- Parse a Caddy access-log JSON message; nil for anything else.
function M.parseAccess(message)
  if type(message) ~= "string" or message:sub(1, 1) ~= "{" then return nil end
  local ok, obj = pcall(util.jsonDecode, message)
  if not ok or type(obj) ~= "table" then return nil end
  local listenerPort = type(obj.logger) == "string" and obj.logger:match("^http%.log%.access%.ecm%-ipv4%-(%d+)$")
  if obj.logger ~= "http.log.access" and not listenerPort then return nil end

  local request = obj.request
  if type(request) ~= "table" then request = {} end

  local status = 0
  if type(obj.status) == "number" then status = obj.status end
  local size = 0
  if type(obj.size) == "number" then size = obj.size end
  local durationMs = 0
  if type(obj.duration) == "number" then
    durationMs = util.round(obj.duration * 1000)
  end

  return {
    host = stringOrEmpty(request.host, 255),
    method = stringOrEmpty(request.method, 16),
    uri = stringOrEmpty(request.uri, 1024),
    status = status,
    durationMs = durationMs,
    durationSeconds = type(obj.duration) == "number" and obj.duration >= 0 and obj.duration or nil,
    size = size,
    remoteIp = stringOrEmpty(request.remote_ip, 64),
    userAgent = clip(firstHeaderValue(request.headers), 512),
  }, listenerPort
end

-- Lowercase, drop a :port suffix (outside IPv6 brackets), drop trailing dot.
function M.normalizeHost(host)
  if type(host) ~= "string" then return "" end
  local s = util.lower(util.trim(host))
  if s == "" then return "" end
  if s:sub(1, 1) == "[" then
    local close = s:find("]", 1, true)
    if close and (close == #s or s:sub(close + 1):match("^:%d+$")) then
      s = s:sub(2, close - 1)
    end
  elseif not s:match(":.*:") then
    s = s:gsub(":%d+$", "")
  end
  s = s:gsub("%.$", "")
  return s
end

local function matchQuery(q, ...)
  if not q or q == "" then return true end
  local count = select("#", ...)
  for i = 1, count do
    local value = select(i, ...)
    if type(value) == "string" and util.lower(value):find(q, 1, true) ~= nil then
      return true
    end
  end
  return false
end

-- Newest-first keeps the freshest complete entries when Host caps stdout at 64 KiB.
-- The raw window is shared across site polls and filter changes for four seconds.
local windowCache
local function accessWindow(unit, lines)
  local now = util.nowEpoch()
  if windowCache and windowCache.unit == unit and windowCache.lines == lines
    and now >= windowCache.at and now - windowCache.at < 4 then return windowCache end
  local ok, result = pcall(host.process.exec, "env", {
    "LC_ALL=C", "journalctl",
    "--unit=" .. unit, "--lines=" .. tostring(lines), "--reverse", "--no-pager", "--output=short-iso",
  }, { timeoutMs = 2000 })
  local window = { unit = unit, lines = lines, at = util.nowEpoch(), rows = {} }
  local stderr = ok and result and (result.stderr or ""):lower() or ""
  if stderr:find("permission", 1, true) or stderr:find("not seeing messages", 1, true)
    or stderr:find("insufficient", 1, true) then
    window.coverage = "restricted"
  elseif not ok or not result or result.exitCode ~= 0 or result.timedOut or result.error then
    window.coverage = "unavailable"
  end
  local raw = ok and result and result.stdout or ""
  if not window.coverage or window.coverage == "restricted" then
    local truncated = result.stdoutTruncated
    if truncated then raw = raw:match("^(.*\n)") or "" end
    local rows = {}
    for _, line in ipairs(util.splitLines(raw)) do
      local parsed = M.parseJournalLine(line)
      if parsed.time:match("^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d") then
        local entry, listenerPort = M.parseAccess(parsed.message)
        if entry then entry.time = parsed.time end
        rows[#rows + 1] = { time = parsed.time, entry = entry, listenerPort = listenerPort }
      end
    end
    window.rows = rows
    window.truncated = truncated
    window.coverage = window.coverage or (truncated and "truncated"
      or (#rows == 0 and "empty" or (#rows >= lines and "line_limit" or "window")))
  end
  windowCache = window
  return window
end

local function belongs(entry, model, listenerPort, ports)
  if listenerPort then return util.contains(model.domains, "0.0.0.0:" .. listenerPort) end
  local name = M.normalizeHost(entry.host)
  local port
  if entry.host:sub(1, 1) == "[" then port = entry.host:match("%]:(%d+)$")
  elseif not entry.host:match(":.*:") then port = entry.host:match(":(%d+)$") end
  port = tonumber(port)

  if model.access then
    name = sites.canonicalIP(name) or name
    return (not port or port == sites.accessPort(model.access)) and util.contains(model.domains, name)
  end
  if port and util.contains(model.domains, name .. ":" .. port) then return true end
  if not util.contains(model.domains, name) then return false end
  return not port or not ports or port == ports.http or (model.https ~= false and port == ports.https)
end

function M.siteEntries(unit, model, lines, opts)
  opts = opts or {}
  local entries = util.array({})
  local summary = { requests = 0, clientErrors = 0, serverErrors = 0, durationSamples = 0, requestedLines = lines }
  if not model then
    summary.coverage = "unsupported"
    return { entries = entries, summary = summary }
  end
  local window = accessWindow(unit, lines)
  local rows = window.rows
  summary.coverage = window.coverage
  summary.truncated = window.truncated or false
  summary.journalLines = #rows
  summary.start = rows[#rows] and rows[#rows].time
  summary.finish = rows[1] and rows[1].time
  local q = type(opts.q) == "string" and util.lower(opts.q) or nil
  local seconds, exactStatus = 0, tonumber(opts.status)
  for i = #rows, 1, -1 do
    local row = rows[i]
    local entry = row.entry
    if entry and belongs(entry, model, row.listenerPort, opts.ports) then
      local statusClass = math.floor(entry.status / 100)
      summary.requests = summary.requests + 1
      if statusClass == 4 then summary.clientErrors = summary.clientErrors + 1 end
      if statusClass == 5 then summary.serverErrors = summary.serverErrors + 1 end
      if entry.durationSeconds then
        seconds = seconds + entry.durationSeconds
        summary.durationSamples = summary.durationSamples + 1
      end
      if (not exactStatus or entry.status == exactStatus)
        and (not opts.statusClass or statusClass == opts.statusClass)
        and matchQuery(q, entry.method, entry.uri, entry.userAgent, entry.host) then
        entries[#entries + 1] = entry
      end
    end
  end
  if summary.durationSamples > 0 then summary.meanMs = seconds / summary.durationSamples * 1000 end
  return { entries = entries, summary = summary }
end

-- Service log lines; access lines are omitted unless opts.includeAccess.
function M.serviceEntries(unit, lines, opts)
  opts = opts or {}
  local entries = util.array({})
  local raw, err = services.logs(unit, lines)
  if not raw then
    return { entries = entries, error = err }
  end

  local q = type(opts.q) == "string" and util.lower(opts.q) or nil
  local includeAccess = opts.includeAccess == true or opts.includeAccess == "true" or opts.includeAccess == "1"

  for i = 1, #raw do
    local parsed = M.parseJournalLine(raw[i])
    -- Older deployed units may still have environment dumps in their journal.
    local variable = parsed.message:match("^([%a_][%w_]*)=")
    if variable then parsed.message = variable .. "= [已隐藏]" end
    local access = M.parseAccess(parsed.message)
    if not access then
      if matchQuery(q, parsed.message) then
        entries[#entries + 1] = {
          time = clip(parsed.time, 64),
          message = clip(parsed.message, 4096),
          access = false,
        }
      end
    elseif includeAccess then
      local text = access.method .. " " .. access.uri .. " "
        .. tostring(access.status) .. " " .. tostring(access.durationMs) .. "ms"
      if matchQuery(q, text) then
        entries[#entries + 1] = {
          time = clip(parsed.time, 64),
          message = clip(text, 4096),
          access = true,
          accessData = access,
        }
      end
    end
  end
  return { entries = entries }
end

local function sanitize(s)
  local text = tostring(s or "")
  text = text:gsub("\r", " ")
  text = text:gsub("\n", " ")
  return text
end

-- Plain-text export for the current journal window.
function M.exportText(unit, scope, model, lines, opts)
  opts = opts or {}
  local out = {}
  if scope == "site" then
    local result = M.siteEntries(unit, model, lines, opts)
    if result.summary.coverage == "unavailable" or (result.summary.coverage == "restricted" and #result.entries == 0) then
      return nil, { code = "journal_unavailable", message = "无法读取站点访问日志。请检查宿主账号的 Journal 读取权限。" }
    end
    for _, entry in ipairs(result.entries) do
      out[#out + 1] = table.concat({
        sanitize(entry.time),
        sanitize(entry.method),
        sanitize(entry.uri),
        tostring(entry.status),
        tostring(entry.durationMs) .. "ms",
        sanitize(entry.remoteIp),
        sanitize(entry.userAgent),
        sanitize(entry.host),
      }, " ")
    end
  elseif scope == "service" then
    local result = M.serviceEntries(unit, lines, { includeAccess = false, q = opts.q })
    if result.error then return nil, result.error end
    for _, entry in ipairs(result.entries) do
      out[#out + 1] = sanitize(entry.time) .. " " .. sanitize(entry.message)
    end
  else
    return nil, { code = "bad_request", message = "无效的导出范围", status = 400 }
  end

  local text = table.concat(out, "\n")
  if #out > 0 then text = text .. "\n" end
  return text
end

return M
