-- journald and Caddy access-log parsing, filtering and export.
local util = require("util")
local services = require("services")

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
  if obj.logger ~= "http.log.access" then return nil end

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
    size = size,
    remoteIp = stringOrEmpty(request.remote_ip, 64),
    userAgent = clip(firstHeaderValue(request.headers), 512),
  }
end

-- Lowercase, drop a :port suffix (outside IPv6 brackets), drop trailing dot.
function M.normalizeHost(host)
  if type(host) ~= "string" then return "" end
  local s = util.lower(util.trim(host))
  if s == "" then return "" end
  if s:sub(1, 1) == "[" then
    local close = s:find("]", 1, true)
    if close and s:sub(close + 1):match("^:%d+$") then
      s = s:sub(1, close)
    end
  else
    s = s:gsub(":%d+$", "")
  end
  s = s:gsub("%.$", "")
  return s
end

function M.matchHost(host, domains)
  local normalized = M.normalizeHost(host)
  if normalized == "" or type(domains) ~= "table" then return false end
  for i = 1, #domains do
    local d = domains[i]
    if type(d) == "string" and util.lower(d) == normalized then return true end
  end
  return false
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

-- Access entries for a site's domains from a journal window.
function M.siteEntries(unit, domains, lines, opts)
  opts = opts or {}
  local entries = util.array({})
  local raw, err = services.logs(unit, lines)
  if not raw then
    return { entries = entries, error = err }
  end

  local domainSet = {}
  if type(domains) == "table" then
    for i = 1, #domains do
      if type(domains[i]) == "string" then domainSet[util.lower(domains[i])] = true end
    end
  end
  local q = type(opts.q) == "string" and util.lower(opts.q) or nil
  local statusFilter = nil
  if type(opts.status) == "number" then
    statusFilter = opts.status
  elseif type(opts.status) == "string" and opts.status:match("^%d+$") then
    statusFilter = tonumber(opts.status)
  end

  for i = 1, #raw do
    local parsed = M.parseJournalLine(raw[i])
    local access = M.parseAccess(parsed.message)
    if access and domainSet[M.normalizeHost(access.host)] then
      local keep = matchQuery(q, access.method, access.uri, access.userAgent, access.host)
      if keep and statusFilter and access.status ~= statusFilter then keep = false end
      if keep then
        entries[#entries + 1] = {
          time = clip(parsed.time, 64),
          host = access.host,
          method = access.method,
          uri = access.uri,
          status = access.status,
          durationMs = access.durationMs,
          size = access.size,
          remoteIp = access.remoteIp,
          userAgent = access.userAgent,
        }
      end
    end
  end
  return { entries = entries }
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
function M.exportText(unit, scope, domains, lines, opts)
  opts = opts or {}
  local out = {}
  if scope == "site" then
    local result = M.siteEntries(unit, domains, lines, opts)
    if result.error then return nil, result.error end
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
