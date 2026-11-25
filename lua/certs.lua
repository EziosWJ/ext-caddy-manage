-- TLS certificate probing via openssl with a cache in SQLite.
local util = require("util")
local store = require("store")
local sites = require("sites")
local settings = require("settings")

local M = {}

local MONTHS = {
  Jan = 1, Feb = 2, Mar = 3, Apr = 4, May = 5, Jun = 6,
  Jul = 7, Aug = 8, Sep = 9, Oct = 10, Nov = 11, Dec = 12,
}

local function clip(s, limit)
  s = tostring(s or "")
  if #s > limit then return s:sub(1, limit) end
  return s
end

local function firstNonEmptyLine(text, limit)
  if type(text) ~= "string" then return "" end
  for line in (text .. "\n"):gmatch("(.-)\n") do
    local trimmed = util.trim(line)
    if trimmed ~= "" then return clip(trimmed, limit) end
  end
  return ""
end

local function friendlyConnectError(message)
  local low = string.lower(message or "")
  if string.find(low, "name or service not known", 1, true)
    or string.find(low, "getaddrinfo", 1, true)
    or string.find(low, "nodename nor servname", 1, true) then
    return "域名解析失败（DNS 无法解析）"
  end
  if string.find(low, "connection refused", 1, true) then
    return "连接被拒绝（443 端口不可达）"
  end
  if string.find(low, "connection timed out", 1, true) then
    return "连接超时（443 端口不可达）"
  end
  if string.find(low, "no peer certificate", 1, true) then
    return "未获取到证书 PEM"
  end
  return clip(message, 500)
end

local function probeError(message)
  return { issuer = "", notAfter = "", error = clip(message, 500) }
end

-- TTL is read live from plugin settings (certProbeHours, hours).
function M.ttlHours()
  local ok, s = pcall(settings.load)
  if ok and type(s) == "table" then
    local hours = tonumber(s.certProbeHours)
    if hours then return hours end
  end
  return 6
end

local function extractPem(stdout)
  if type(stdout) ~= "string" then return nil end
  local beginAt = stdout:find("-----BEGIN CERTIFICATE-----", 1, true)
  if not beginAt then return nil end
  local endAt = stdout:find("-----END CERTIFICATE-----", beginAt, true)
  if not endAt then return nil end
  return stdout:sub(beginAt, endAt + #"-----END CERTIFICATE-----" - 1)
end

local function parseNotAfter(value)
  local monthName, day, hour, minute, second, year =
    value:match("^(%a+)%s+(%d+)%s+(%d+):(%d+):(%d+)%s+(%d+)%s+GMT$")
  if not monthName then return nil end
  local month = MONTHS[monthName]
  if not month then return nil end
  local epoch = util.utcEpoch(
    tonumber(year), month, tonumber(day),
    tonumber(hour), tonumber(minute), tonumber(second)
  )
  if type(epoch) ~= "number" then return nil end
  local formatted = os.date("!%Y-%m-%dT%H:%M:%S", epoch)
  if type(formatted) ~= "string" then return nil end
  return formatted .. "Z"
end

-- Probe a domain's live certificate. Never throws; errors are in the result.
function M.probe(domain)
  if type(domain) ~= "string" or domain == "" then return probeError("域名无效") end

  local okConnect, connect, connectErr = pcall(host.process.exec, "openssl", {
    "s_client",
    "-connect", domain .. ":443",
    "-servername", domain,
    "-showcerts",
  }, { timeoutMs = 8000 })
  if not okConnect then
    return probeError("无法执行 openssl：" .. tostring(connect))
  end
  if not connect then
    return probeError("无法执行 openssl：" .. tostring(connectErr))
  end
  if connect.timedOut then
    return probeError("TLS 探测超时（8000 ms）")
  end
  if connect.error then
    return probeError("TLS 探测失败：" .. tostring(connect.error))
  end
  if connect.exitCode ~= 0 then
    local line = firstNonEmptyLine(connect.stderr, 500)
    if line == "" then line = "openssl s_client 退出码 " .. tostring(connect.exitCode) end
    return probeError(friendlyConnectError(line))
  end

  local pem = extractPem(connect.stdout)
  if not pem then
    local line = firstNonEmptyLine(connect.stderr, 500)
    if line == "" then line = "未获取到证书 PEM" end
    return probeError(friendlyConnectError(line))
  end

  local okX509, x509, x509Err = pcall(host.process.exec, "openssl", {
    "x509", "-noout", "-subject", "-issuer", "-enddate",
  }, { stdin = pem, timeoutMs = 5000 })
  if not okX509 then
    return probeError("无法执行 openssl：" .. tostring(x509))
  end
  if not x509 then
    return probeError("无法执行 openssl：" .. tostring(x509Err))
  end
  if x509.timedOut then
    return probeError("证书解析超时（5000 ms）")
  end
  if x509.error then
    return probeError("证书解析失败：" .. tostring(x509.error))
  end
  if x509.exitCode ~= 0 then
    local line = firstNonEmptyLine(x509.stderr, 500)
    if line == "" then line = "openssl x509 退出码 " .. tostring(x509.exitCode) end
    return probeError(line)
  end

  local stdout = type(x509.stdout) == "string" and x509.stdout or ""
  local issuer = ""
  local notAfterValue = nil
  for line in (stdout .. "\n"):gmatch("(.-)\n") do
    local issuerValue = line:match("^issuer=(.*)$")
    if issuerValue then issuer = util.trim(issuerValue) end
    local endValue = line:match("^notAfter=(.*)$")
    if endValue then notAfterValue = util.trim(endValue) end
  end
  if not notAfterValue or notAfterValue == "" then
    return probeError("无法解析证书到期时间")
  end
  local notAfter = parseNotAfter(notAfterValue)
  if not notAfter then
    return probeError("无法解析证书到期时间：" .. clip(notAfterValue, 200))
  end
  return { issuer = issuer, notAfter = notAfter, error = "" }
end

local function cacheMap()
  local map = {}
  local ok, rows = pcall(store.listCerts)
  if ok and type(rows) == "table" then
    for _, row in ipairs(rows) do
      if type(row) == "table" and type(row.domain) == "string" then
        map[util.lower(row.domain)] = row
      end
    end
  end
  return map
end

local function siteItemsOf(value)
  if type(value) ~= "table" then return nil end
  if type(value.items) == "table" then return value.items end
  return value
end

-- Probe stale cached domains (or all when force). Never throws.
function M.refresh(sitesArg, opts)
  opts = opts or {}
  local force = opts.force == true
  local now = type(opts.now) == "number" and opts.now or util.nowEpoch()
  local ttl = M.ttlHours()
  local items = siteItemsOf(sitesArg)
  local okDomains, domains = pcall(sites.certDomains, items)
  if not okDomains or type(domains) ~= "table" then domains = util.array({}) end
  local cache = cacheMap()

  local refreshed = 0
  local errors = 0
  local out = util.array({})

  for _, domain in ipairs(domains) do
    local cached = cache[domain]
    local stale = true
    if cached and not force then
      local checkedEpoch = util.parseUTC(type(cached.checked_at) == "string" and cached.checked_at or "")
      if checkedEpoch then
        local age = now - checkedEpoch
        if age < ttl * 3600 then stale = false end
      end
    end

    if stale then
      local okProbe, result = pcall(M.probe, domain)
      if not okProbe then
        result = { issuer = "", notAfter = "", error = "探测异常：" .. tostring(result) }
      end
      if type(result) ~= "table" then
        result = { issuer = "", notAfter = "", error = "探测结果无效" }
      end
      local checkedAt = util.nowUTC()
      local errText = type(result.error) == "string" and result.error or ""
      if errText ~= "" then
        errors = errors + 1
        pcall(store.upsertCert, domain, "", "", checkedAt, clip(errText, 2000))
        out[#out + 1] = {
          domain = domain,
          issuer = "",
          not_after = "",
          checked_at = checkedAt,
          error = clip(errText, 2000),
        }
      else
        refreshed = refreshed + 1
        local issuer = type(result.issuer) == "string" and result.issuer or ""
        local notAfter = type(result.notAfter) == "string" and result.notAfter or ""
        pcall(store.upsertCert, domain, issuer, notAfter, checkedAt, "")
        out[#out + 1] = {
          domain = domain,
          issuer = issuer,
          not_after = notAfter,
          checked_at = checkedAt,
          error = "",
        }
      end
    end
  end

  return { refreshed = refreshed, errors = errors, items = out }
end

local function sortCertItems(items)
  table.sort(items, function(a, b)
    if a.days == nil and b.days == nil then return a.domain < b.domain end
    if a.days == nil then return false end
    if b.days == nil then return true end
    if a.days ~= b.days then return a.days < b.days end
    return a.domain < b.domain
  end)
end

-- Cert cache rows for an explicit list of domains.
function M.forDomains(domains, now)
  now = type(now) == "number" and now or util.nowEpoch()
  local cache = cacheMap()
  local out = util.array({})
  local seen = {}
  if type(domains) ~= "table" then return out end
  for i = 1, #domains do
    local domain = domains[i]
    if type(domain) == "string" and domain ~= "" then
      local ld = util.lower(domain)
      if not seen[ld] then
        seen[ld] = true
        local cached = cache[ld]
        local item = {
          domain = ld,
          issuer = "",
          not_after = "",
          checked_at = "",
          error = "未探测",
          expiring = false,
        }
        if cached then
          item.issuer = type(cached.issuer) == "string" and cached.issuer or ""
          item.not_after = type(cached.not_after) == "string" and cached.not_after or ""
          item.checked_at = type(cached.checked_at) == "string" and cached.checked_at or ""
          item.error = type(cached.error) == "string" and cached.error or ""
          local epoch = util.parseUTC(item.not_after)
          if epoch then
            item.days = util.daysUntil(epoch, now)
            item.expiring = item.days <= 14
          end
        end
        out[#out + 1] = item
      end
    end
  end
  sortCertItems(out)
  return out
end

-- Cert cache rows for enabled managed HTTPS sites.
function M.list(siteItems, now)
  local items = siteItemsOf(siteItems)
  local domains = sites.certDomains(items)
  return M.forDomains(domains, now)
end

-- Register the periodic refresh task; never fails startup.
function M.schedule()
  local hours = M.ttlHours()
  if hours < 1 then hours = 1 end
  if hours > 168 then hours = 168 end
  local expression = "@every " .. tostring(hours) .. "h"

  local function run()
    local ok = pcall(function()
      local all = sites.loadAll()
      M.refresh(all, { force = false })
    end)
    if not ok then print("certs refresh failed") end
  end

  local okCall, result, err = pcall(function()
    return host.schedule.register("certs-refresh", expression, run)
  end)
  if not okCall then
    return nil, {
      code = "service_error",
      message = "证书探测任务注册失败",
      details = { error = tostring(result) },
    }
  end
  if not result then
    return nil, {
      code = "service_error",
      message = "证书探测任务注册失败（" .. expression .. "）",
      details = { error = tostring(err) },
    }
  end
  return true
end

-- M.TTL_HOURS exposes the live settings value for callers that read it as a
-- constant; config hot-reloads, so it is resolved through __index.
setmetatable(M, {
  __index = function(_, key)
    if key == "TTL_HOURS" then return M.ttlHours() end
    return nil
  end,
})

return M
