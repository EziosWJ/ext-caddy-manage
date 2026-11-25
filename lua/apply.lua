-- apply.lua: backup, atomic write, validation, reload and rollback orchestration.
-- This module is the safety net for every configuration change. All functions
-- return a result table or nil plus an error table {code,message,details,status}.

local util = require("util")
local fs = require("fs")
local settings = require("settings")
local caddy = require("caddy")
local services = require("services")
local sites = require("sites")
local store = require("store")

local M = {}

local START_MARKER = "# >>> ext-caddy-manage:global"
local END_MARKER = "# <<< ext-caddy-manage:global"
local DEFAULT_ADMIN = "admin 127.0.0.1:2019"
local STAGING_CA = "https://acme-staging-v02.api.letsencrypt.org/directory"

local CONNECTION_MARKERS = {
  "connection refused",
  "connect: no such file",
  "dial tcp",
  "failed to connect",
  "admin endpoint",
  "connection reset",
}

local function fail(code, message, details, status)
  return nil, { code = code, message = message, details = details, status = status }
end

local function cap(s, limit)
  if type(s) ~= "string" then return "" end
  limit = limit or 2000
  if #s > limit then return string.sub(s, 1, limit) end
  return s
end

local function firstLine(s)
  if type(s) ~= "string" or s == "" then return "" end
  local line = string.match(s, "^([^\r\n]*)")
  return line or ""
end

-- Extract a human-readable message from a caddy.lua error table.
local function caddyOutput(e)
  if type(e) ~= "table" then return "" end
  local d = e.details or {}
  local out = d.stderr
  if type(out) ~= "string" or out == "" then out = d.stdout end
  if type(out) ~= "string" or out == "" then out = e.message end
  if type(out) ~= "string" then out = "" end
  return out
end

local function caddyMessage(e)
  local msg = firstLine(caddyOutput(e))
  if msg == "" and type(e) == "table" and type(e.message) == "string" then
    msg = e.message
  end
  if msg == "" then msg = "配置校验失败" end
  return cap(msg)
end

local function isConnectionError(e)
  local text = ""
  if type(e) == "table" then
    text = tostring(e.message or "")
    local d = e.details or {}
    text = text .. "\n" .. tostring(d.stderr or "") .. "\n" .. tostring(d.stdout or "")
  elseif e ~= nil then
    text = tostring(e)
  end
  text = util.lower(text)
  for _, marker in ipairs(CONNECTION_MARKERS) do
    if string.find(text, marker, 1, true) then return true end
  end
  return false
end

-- Restore a file to its previous content (nil means the file did not exist).
local function restoreFile(path, content)
  if content ~= nil then
    return fs.writeAtomic(path, content, "0644")
  end
  return fs.remove(path)
end

-- Decide whether a reload is needed based on the service state.
-- Returns "reload" (running), "skip" (known stopped) or "attempt" (unknown).
local function reloadDecision()
  local s = settings.load()
  local state, serr = services.state(s.serviceUnit)
  if serr then return "attempt", nil end
  if state == "running" then return "reload", state end
  if state == "stopped" or state == "failed" or state == "completed" then
    return "skip", state
  end
  return "attempt", state
end

function M.adminAddress(s)
  local raw = fs.read(s.mainConfig)
  if raw == nil then return nil end
  local address = nil
  for _, line in ipairs(util.splitLines(raw)) do
    local value = string.match(line, "^%s*admin%s+(.+)$")
    if value then
      local trimmedValue = util.trim(value)
      if trimmedValue ~= "{" and trimmedValue ~= "}" then address = trimmedValue end
    end
  end
  if address == nil or address == "" then address = "127.0.0.1:2019" end
  return address
end

-- Probe whether the Caddy admin endpoint accepts TCP connections. This is
-- only used when host.services cannot tell us whether Caddy is running (for
-- example when the systemd backend is unavailable).
local function adminReachable(s)
  local address = M.adminAddress(s)
  if address == nil then return false end
  address = util.trim(address)
  address = address:gsub("^https?://", "")
  if address == "off" then return false end
  if util.startsWith(address, "unix/") or util.startsWith(address, "unix//") then
    return nil
  end
  if string.sub(address, 1, 1) == ":" then address = "127.0.0.1" .. address end
  local ok, result = pcall(host.process.exec, "openssl", {
    "s_client", "-connect", address, "-servername", "localhost",
  }, { timeoutMs = 2000 })
  if not ok or type(result) ~= "table" then return nil end
  local text = tostring(result.stdout or "") .. "\n" .. tostring(result.stderr or "")
  if string.find(text, "CONNECTED", 1, true) then return true end
  if result.timedOut then return false end
  if tonumber(result.exitCode) == 0 then return true end
  return false
end

-- Reload after a validated write. Returns an apply table or nil, caddy error.
-- Admin-unreachable failures are treated as saved-only because the config was
-- already validated.
function M.reloadAfterChange(wasRunningHint)
  local s = settings.load()
  local action
  if wasRunningHint == true then
    action = "reload"
  elseif wasRunningHint == false then
    action = "skip"
  else
    action = reloadDecision()
  end
  if action == "skip" then
    return { savedOnly = true, reloaded = false, message = "已保存（服务未运行，未重载）" }
  end
  if action == "attempt" then
    local reachable = adminReachable(s)
    if reachable == false then
      return { savedOnly = true, reloaded = false, message = "已保存（Caddy 未运行或管理接口不可达，未重载）" }
    end
  end
  local r = caddy.reload(s.mainConfig)
  if type(r) == "table" and r.ok then
    return { savedOnly = false, reloaded = true, message = "配置已重载" }
  end
  local e = (type(r) == "table" and r.error) or { code = "reload_failed", message = "Caddy 重载失败" }
  -- An admin API that cannot be reached (including the 20s exec timeout when
  -- nothing is listening) does not invalidate the already-validated config.
  local unreachable = isConnectionError(e)
  if unreachable then
    return { savedOnly = true, reloaded = false, message = "已保存（Caddy 未运行或管理接口不可达，未重载）" }
  end
  return nil, e
end

-- ---------------------------------------------------------------------------
-- Global block parsing/rendering
-- ---------------------------------------------------------------------------

local function scanLines(raw)
  local lines = {}
  local n = #raw
  local pos = 1
  while pos <= n do
    local nl = string.find(raw, "\n", pos, true)
    local textEnd = nl and (nl - 1) or n
    local text = string.sub(raw, pos, textEnd)
    if string.sub(text, -1) == "\r" then text = string.sub(text, 1, -2) end
    lines[#lines + 1] = { text = text, startPos = pos, endPos = textEnd, nl = nl }
    if not nl then break end
    pos = nl + 1
  end
  return lines
end

local function trimTrailing(s)
  if type(s) ~= "string" then return "" end
  return (string.gsub(s, "%s+$", ""))
end

local function stripOneTab(s)
  if string.sub(s, 1, 1) == "\t" then return string.sub(s, 2) end
  return s
end

function M.parseGlobal(raw)
  if type(raw) ~= "string" then
    return fail("bad_request", "主 Caddyfile 内容无效")
  end
  local res = {
    hasMarkers = false,
    block = "",
    email = "",
    staging = false,
    extra = "",
    admin = nil,
    startLine = nil,
    endLine = nil,
    startByte = nil,
    endByte = nil,
    before = raw,
    after = "",
  }
  local lines = scanLines(raw)
  local startIdx, endIdx
  for i = 1, #lines do
    if lines[i].text == START_MARKER then startIdx = i break end
  end
  if startIdx then
    for i = startIdx + 1, #lines do
      if lines[i].text == END_MARKER then endIdx = i break end
    end
  end
  if not startIdx or not endIdx then return res end

  local openIdx, closeIdx
  for i = startIdx + 1, endIdx - 1 do
    if util.trim(lines[i].text) == "{" then openIdx = i break end
  end
  if openIdx then
    for i = endIdx - 1, openIdx + 1, -1 do
      if util.trim(lines[i].text) == "}" then closeIdx = i break end
    end
  end
  if not openIdx or not closeIdx then return res end

  res.hasMarkers = true
  res.startLine = startIdx
  res.endLine = endIdx
  res.startByte = lines[startIdx].startPos
  res.endByte = lines[endIdx].endPos
  res.before = string.sub(raw, 1, lines[startIdx].startPos - 1)
  if lines[endIdx].nl then
    res.after = string.sub(raw, lines[endIdx].nl + 1)
  else
    res.after = ""
  end

  local blockLines = {}
  for i = openIdx, closeIdx do blockLines[#blockLines + 1] = lines[i].text end
  res.block = table.concat(blockLines, "\n")

  local email = ""
  local admin = nil
  local staging = false
  local extraLines = {}
  for i = openIdx + 1, closeIdx - 1 do
    local text = lines[i].text
    local trimmed = util.trim(text)
    local emailValue = string.match(trimmed, "^email%s+(%S+)$")
    local isEmail = emailValue ~= nil
    if isEmail then email = emailValue end
    local isAcmeCa = string.match(trimmed, "^acme_ca%s+") ~= nil
    local isStagingCa = isAcmeCa and string.find(trimmed, "acme-staging-v02", 1, true) ~= nil
    if isStagingCa then staging = true end
    local adminValue = string.match(trimmed, "^admin%s+(.+)$")
    if adminValue then admin = util.trim(adminValue) end
    if not isEmail
      and not isStagingCa
      and trimmed ~= DEFAULT_ADMIN then
      local line = trimTrailing(stripOneTab(text))
      extraLines[#extraLines + 1] = line
    end
  end
  while #extraLines > 0 and extraLines[1] == "" do table.remove(extraLines, 1) end
  while #extraLines > 0 and extraLines[#extraLines] == "" do table.remove(extraLines) end
  res.email = email
  res.staging = staging
  res.admin = admin
  res.extra = table.concat(extraLines, "\n")
  return res
end

-- Legacy host-only site addresses inherit the Caddyfile's HTTP(S) ports.
function M.httpPorts(raw)
  local ports = { http = 80, https = 443 }
  if type(raw) ~= "string" then return ports end
  local parsed = M.parseGlobal(raw)
  local source = parsed and parsed.hasMarkers and parsed.block or raw
  for _, line in ipairs(util.splitLines(source)) do
    local protocol, port = util.trim(line):match("^(https?)_port%s+(%d+)$")
    if not protocol then
      protocol, port = util.trim(line):match("^(https?)_port%s+(%d+)%s+#")
    end
    port = tonumber(port)
    if protocol and port and port >= 1 and port <= 65535 then ports[protocol] = port end
  end
  return ports
end

function M.renderGlobal(form)
  form = form or {}
  local email = form.email
  if email == nil then email = "" end
  if type(email) ~= "string" then
    return fail("invalid_model", "邮箱必须为字符串", { field = "email" })
  end
  email = util.trim(email)
  -- Lua 5.1 patterns cannot apply a quantifier to a capture group, so the
  -- domain tail is one character class that must contain at least one dot.
  if email ~= "" and not string.match(email, "^[A-Za-z0-9._%%+%-]+@[A-Za-z0-9%-]+[.][A-Za-z0-9%.-]+$") then
    return fail("invalid_model", "邮箱格式不正确", { field = "email" })
  end
  local staging = false
  if form.staging ~= nil then
    if type(form.staging) ~= "boolean" then
      return fail("invalid_model", "staging 必须为布尔值", { field = "staging" })
    end
    staging = form.staging
  end
  local extra = form.extra
  if extra == nil then extra = "" end
  if type(extra) ~= "string" then
    return fail("invalid_model", "额外全局指令必须为字符串", { field = "extra" })
  end
  if #extra > 46 * 1024 then
    return fail("size_limit", "额外全局指令超过 46 KiB 限制", { limit = 46 * 1024 })
  end
  if string.find(extra, "\0", 1, true) then
    return fail("invalid_model", "额外全局指令不能包含 NUL 字符", { field = "extra" })
  end
  if string.find(extra, "\r", 1, true) then
    return fail("invalid_model", "额外全局指令只能使用 LF 换行", { field = "extra" })
  end
  local extraLines = util.splitLines(extra)
  local extraAdmin = nil
  local extraAcmeCa = false
  for _, line in ipairs(extraLines) do
    local trimmed = util.trim(line)
    if trimmed == START_MARKER or trimmed == END_MARKER then
      return fail("invalid_model", "额外全局指令不能包含受管标记行", { field = "extra" })
    end
    if string.match(trimmed, "^email%s+") then
      return fail("invalid_model", "额外全局指令不能包含 email；请使用邮箱字段", { field = "extra" })
    end
    if string.match(trimmed, "^acme_ca%s+") then
      extraAcmeCa = true
    end
    local value = string.match(trimmed, "^admin%s+(.+)$")
    if value then extraAdmin = util.trim(value) end
  end
  if staging and extraAcmeCa then
    return fail("invalid_model", "额外全局指令已包含 acme_ca，不能同时启用 staging", { field = "extra" })
  end

  local adminLine = nil
  if extraAdmin == nil then
    local admin = form.admin
    if admin == nil or (type(admin) == "string" and util.trim(admin) == "") then
      adminLine = DEFAULT_ADMIN
    elseif type(admin) ~= "string" then
      return fail("invalid_model", "admin 必须为字符串", { field = "admin" })
    else
      admin = util.trim(admin)
      if #admin > 256 or string.find(admin, "%s")
        or string.find(admin, "\0", 1, true)
        or string.find(admin, "{", 1, true)
        or string.find(admin, "}", 1, true) then
        return fail("invalid_model", "admin 地址不合法", { field = "admin" })
      end
      adminLine = "admin " .. admin
    end
  end

  local out = {}
  out[#out + 1] = START_MARKER
  out[#out + 1] = "{"
  if email ~= "" then out[#out + 1] = "\temail " .. email end
  if staging then out[#out + 1] = "\tacme_ca " .. STAGING_CA end
  if adminLine ~= nil then out[#out + 1] = "\t" .. adminLine end
  for _, line in ipairs(extraLines) do
    if line == "" then
      out[#out + 1] = ""
    else
      out[#out + 1] = "\t" .. line
    end
  end
  out[#out + 1] = "}"
  out[#out + 1] = END_MARKER
  return table.concat(out, "\n") .. "\n"
end

-- ---------------------------------------------------------------------------
-- Rollback helpers
-- ---------------------------------------------------------------------------

local function rollbackSiteAfterValidate(s, target, current, validateErr, backupName)
  local details = { caddy = validateErr, backup = backupName, rollback = { restored = false, ok = false } }
  local restored, rerr = restoreFile(target, current)
  details.rollback.restored = restored and true or false
  if not restored then
    details.rollback.message = "还原片段失败：" .. tostring(rerr)
    return fail("rollback_failed", "整体配置校验失败，且还原片段失败", details)
  end
  local v = caddy.validateMain(s.mainConfig)
  details.rollback.validate = { ok = v.ok and true or false }
  if not v.ok then
    details.rollback.validate.message = caddyMessage(v.error)
  end
  -- The write was safely undone. A pre-existing invalid config elsewhere is
  -- still a validation failure, not a rollback failure.
  details.rollback.ok = v.ok and true or false
  return fail("validate_failed", "整体配置校验失败，未写入配置", details)
end

local function rollbackSiteAfterReload(s, target, current, reloadErr, backupName)
  local details = { caddy = reloadErr, backup = backupName, rollback = { restored = false, ok = false } }
  local restored, rerr = restoreFile(target, current)
  details.rollback.restored = restored and true or false
  if not restored then
    details.rollback.message = "还原片段失败：" .. tostring(rerr)
    return fail("rollback_failed", "Caddy 重载失败，且还原片段失败", details)
  end
  local v = caddy.validateMain(s.mainConfig)
  details.rollback.validate = { ok = v.ok and true or false }
  if not v.ok then
    details.rollback.validate.message = caddyMessage(v.error)
    details.rollback.ok = false
    return fail("rollback_failed", "已还原片段，但整体配置校验失败", details)
  end
  local r = caddy.reload(s.mainConfig)
  details.rollback.reload = { ok = r.ok and true or false }
  if not r.ok then
    details.rollback.reload.message = caddyMessage(r.error)
    details.rollback.ok = false
    return fail("rollback_failed", "已还原片段，但旧配置重载失败", details)
  end
  details.rollback.ok = true
  return fail("reload_failed", "Caddy 重载失败，已自动回滚", details)
end

local function rollbackMainAfterValidate(s, current, validateErr, backupName)
  local details = { caddy = validateErr, backup = backupName, rollback = { restored = false, ok = false } }
  local restored, rerr
  if current ~= nil then
    restored, rerr = fs.writeAtomic(s.mainConfig, current, "0644")
  else
    restored, rerr = fs.remove(s.mainConfig)
  end
  details.rollback.restored = restored and true or false
  if not restored then
    details.rollback.message = "还原主 Caddyfile 失败：" .. tostring(rerr)
    return fail("rollback_failed", "整体配置校验失败，且还原主 Caddyfile 失败", details)
  end
  if current ~= nil then
    local v = caddy.validateMain(s.mainConfig)
    details.rollback.validate = { ok = v.ok and true or false }
    if not v.ok then
      details.rollback.validate.message = caddyMessage(v.error)
    end
    details.rollback.ok = v.ok and true or false
  else
    details.rollback.validate = { ok = true, skipped = true }
    details.rollback.ok = true
  end
  return fail("validate_failed", "整体配置校验失败，未保存", details)
end

local function rollbackMainAfterReload(s, current, reloadErr, backupName)
  local details = { caddy = reloadErr, backup = backupName, rollback = { restored = false, ok = false } }
  local restored, rerr
  if current ~= nil then
    restored, rerr = fs.writeAtomic(s.mainConfig, current, "0644")
  else
    restored, rerr = fs.remove(s.mainConfig)
  end
  details.rollback.restored = restored and true or false
  if not restored then
    details.rollback.message = "还原主 Caddyfile 失败：" .. tostring(rerr)
    return fail("rollback_failed", "Caddy 重载失败，且还原主 Caddyfile 失败", details)
  end
  if current == nil then
    details.rollback.validate = { ok = true, skipped = true }
    details.rollback.reload = { ok = true, skipped = true }
    details.rollback.ok = true
    return fail("reload_failed", "Caddy 重载失败，已恢复原状态", details)
  end
  local v = caddy.validateMain(s.mainConfig)
  details.rollback.validate = { ok = v.ok and true or false }
  if not v.ok then
    details.rollback.validate.message = caddyMessage(v.error)
    details.rollback.ok = false
    return fail("rollback_failed", "已还原主 Caddyfile，但整体配置校验失败", details)
  end
  local r = caddy.reload(s.mainConfig)
  details.rollback.reload = { ok = r.ok and true or false }
  if not r.ok then
    details.rollback.reload.message = caddyMessage(r.error)
    details.rollback.ok = false
    return fail("rollback_failed", "已还原主 Caddyfile，但旧配置重载失败", details)
  end
  details.rollback.ok = true
  return fail("reload_failed", "Caddy 重载失败，已自动回滚", details)
end

-- ---------------------------------------------------------------------------
-- Initial configuration
-- ---------------------------------------------------------------------------

function M.initialConfig()
  local s = settings.load()
  local mainDir = util.dirname(s.mainConfig)
  local importPath
  if s.snippetDir == mainDir then
    importPath = "*.caddy"
  elseif mainDir == "/" then
    importPath = string.sub(s.snippetDir, 2) .. "/*.caddy"
  else
    local prefix = mainDir .. "/"
    if string.sub(s.snippetDir, 1, #prefix) == prefix then
      importPath = string.sub(s.snippetDir, #prefix + 1) .. "/*.caddy"
    else
      importPath = s.snippetDir .. "/*.caddy"
    end
  end
  -- A configured snippet directory may contain spaces; Caddy accepts a quoted
  -- import pattern.
  if not string.match(importPath, "^[A-Za-z0-9_./%%*%-]+$") then
    importPath = '"' .. importPath:gsub("\\", "\\\\"):gsub('"', '\\"') .. '"'
  end
  return table.concat({
    START_MARKER,
    "{",
    "\t" .. DEFAULT_ADMIN,
    "}",
    END_MARKER,
    "import " .. importPath,
  }, "\n") .. "\n"
end

-- The configured snippet directory must be reachable through a Caddyfile
-- import glob. Without this check a site write can validate and reload a main
-- config that never includes the new snippet.
local function snippetImportForms(s)
  local mainDir = util.dirname(s.mainConfig)
  local forms = { [s.snippetDir] = true }
  if s.snippetDir == mainDir then
    forms[""] = true
  elseif mainDir == "/" then
    forms[string.sub(s.snippetDir, 2)] = true
  else
    local prefix = mainDir .. "/"
    if string.sub(s.snippetDir, 1, #prefix) == prefix then
      forms[string.sub(s.snippetDir, #prefix + 1)] = true
    end
  end
  return forms
end

local function importBase(token)
  local base = token
  base = base:gsub("/%*%.caddy$", "")
  base = base:gsub("^%*%.caddy$", "")
  base = base:gsub("/%*$", "")
  base = base:gsub("/+$", "")
  if base == "." then base = "" end
  base = base:gsub("^%./", "")
  return base
end

function M.hasSnippetImport(raw, s)
  s = s or settings.load()
  if type(raw) ~= "string" or raw == "" then return false end
  local forms = snippetImportForms(s)
  for _, line in ipairs(util.splitLines(raw)) do
    local rest = string.match(line, "^%s*import%s+(.+)$")
    if rest then
      rest = util.trim(rest)
      local token
      if string.sub(rest, 1, 1) == '"' then
        token = string.match(rest, '^"([^"]*)"')
      else
        token = string.match(rest, "^(%S+)")
      end
      if token and string.find(token, "*", 1, true) then
        local base = importBase(token)
        if forms[base] then return true end
        -- Compare the resolved absolute form for a relative import.
        if base ~= "" and string.sub(base, 1, 1) ~= "/" then
          local absolute = util.join(util.dirname(s.mainConfig), base)
          if forms[absolute] then return true end
        end
      end
    end
  end
  return false
end

-- ---------------------------------------------------------------------------
-- Site snippet writes
-- ---------------------------------------------------------------------------

function M.writeSite(opts)
  opts = opts or {}
  local s = settings.load()
  local slug = opts.slug
  if type(slug) ~= "string" or not util.safeSlug(slug) then
    return fail("bad_request", "站点 slug 不合法", { slug = slug })
  end
  local content = opts.content
  if type(content) ~= "string" or content == "" then
    return fail("bad_request", "站点片段内容不能为空")
  end
  if #content > fs.LIMIT then
    return fail("size_limit", "站点片段超过 48 KiB 限制", { bytes = #content, limit = fs.LIMIT })
  end
  local enabled = opts.enabled
  if enabled == nil then enabled = true end
  if type(enabled) ~= "boolean" then
    return fail("bad_request", "enabled 必须为布尔值")
  end

  local mainRaw, mainExists, mainReadErr = fs.readExisting(s.mainConfig)
  if mainReadErr then
    return fail("internal", "读取主 Caddyfile 失败：" .. tostring(mainReadErr), { path = s.mainConfig })
  end
  if not mainExists then
    return fail("not_initialized", "主 Caddyfile 不存在，请先在诊断页生成初始配置", { mainConfig = s.mainConfig })
  end
  if not M.hasSnippetImport(mainRaw, s) then
    return fail("not_initialized", "主 Caddyfile 未导入站点片段目录，站点不会生效", {
      mainConfig = s.mainConfig,
      snippetDir = s.snippetDir,
      hint = "在全局配置原文中添加 import <片段目录>/*.caddy",
    })
  end

  local target = sites.snippetPath(slug, enabled)
  local other = sites.snippetPath(slug, not enabled)
  local targetInfo, targetExists, targetStatErr = fs.statChecked(target)
  if targetStatErr then
    return fail("internal", "读取站点片段状态失败：" .. tostring(targetStatErr), { path = target })
  end
  local otherInfo, otherExists, otherStatErr = fs.statChecked(other)
  if otherStatErr then
    return fail("internal", "读取站点片段状态失败：" .. tostring(otherStatErr), { path = other })
  end
  if otherExists then
    return fail("conflict", "站点片段同时存在于启用与停用目录，请先处理", { slug = slug, path = other })
  end
  if targetExists and targetInfo.type ~= "file" then
    return fail("internal", "站点片段路径不是普通文件", { path = target })
  end
  if not targetExists and not opts.allowCreate then
    return fail("not_found", "站点片段不存在", { slug = slug, path = target })
  end
  local current = nil
  if targetExists then
    local c, rerr = fs.read(target)
    if c == nil then
      return fail("internal", "读取站点片段失败：" .. tostring(rerr), { path = target })
    end
    current = c
  end

  if opts.baseline ~= nil and current ~= opts.baseline and not opts.force then
    return fail("conflict", "站点片段已被外部修改，请确认后再保存", {
      slug = slug,
      current = current,
      enabled = enabled,
    })
  end

  local v = caddy.validateSnippet(content)
  if not v.ok then
    local e = v.error
    return fail("validate_failed", "站点片段校验失败：" .. caddyMessage(e), {
      output = cap(caddyOutput(e), 8192),
      slug = slug,
    })
  end

  local backupName = nil
  if current ~= nil then
    local name, berr = fs.backup(target, opts.reason or "form", s.backupKeep)
    if name == nil then
      return fail("internal", "备份站点片段失败：" .. tostring(berr), { path = target })
    end
    backupName = name
  end

  local dir = util.dirname(target)
  local mok, merr = fs.mkdirp(dir)
  if not mok then
    return fail("internal", "创建站点片段目录失败：" .. tostring(merr), { path = dir })
  end
  local wok, werr = fs.writeAtomic(target, content, "0644")
  if not wok then
    return fail("internal", "写入站点片段失败：" .. tostring(werr), { path = target })
  end

  local vm = caddy.validateMain(s.mainConfig)
  if not vm.ok then
    return rollbackSiteAfterValidate(s, target, current, vm.error, backupName)
  end

  if not enabled then
    return {
      slug = slug,
      path = target,
      enabled = false,
      bytes = #content,
      backup = backupName,
      apply = { savedOnly = true, reloaded = false, message = "已保存（站点已停用，未重载）" },
    }
  end

  local applyRes, relErr = M.reloadAfterChange()
  if not applyRes then
    return rollbackSiteAfterReload(s, target, current, relErr, backupName)
  end
  return {
    slug = slug,
    path = target,
    enabled = true,
    bytes = #content,
    backup = backupName,
    apply = applyRes,
  }
end

function M.setEnabled(slug, enabled, baseline)
  if type(slug) ~= "string" or not util.safeSlug(slug) then
    return fail("bad_request", "站点 slug 不合法", { slug = slug })
  end
  if type(enabled) ~= "boolean" then
    return fail("bad_request", "enabled 必须为布尔值")
  end
  local s = settings.load()
  local enabledPath = sites.snippetPath(slug, true)
  local disabledPath = sites.snippetPath(slug, false)
  local enabledInfo, enabledExists, enabledStatErr = fs.statChecked(enabledPath)
  if enabledStatErr then
    return fail("internal", "读取站点片段状态失败：" .. tostring(enabledStatErr), { path = enabledPath })
  end
  local disabledInfo, disabledExists, disabledStatErr = fs.statChecked(disabledPath)
  if disabledStatErr then
    return fail("internal", "读取站点片段状态失败：" .. tostring(disabledStatErr), { path = disabledPath })
  end
  if enabledExists and enabledInfo.type ~= "file" then
    return fail("internal", "站点片段路径不是普通文件", { path = enabledPath })
  end
  if disabledExists and disabledInfo.type ~= "file" then
    return fail("internal", "站点片段路径不是普通文件", { path = disabledPath })
  end
  if enabledExists and disabledExists then
    return fail("conflict", "站点片段同时存在于启用与停用目录，请先处理", { slug = slug })
  end
  if not enabledExists and not disabledExists then
    return fail("not_found", "站点片段不存在", { slug = slug })
  end
  if (enabled and enabledExists) or ((not enabled) and disabledExists) then
    return {
      slug = slug,
      path = enabled and enabledPath or disabledPath,
      enabled = enabled,
      apply = { savedOnly = true, reloaded = false, message = "状态未变化" },
    }
  end

  local mainRaw, mainExists, mainReadErr = fs.readExisting(s.mainConfig)
  if mainReadErr then
    return fail("internal", "读取主 Caddyfile 失败：" .. tostring(mainReadErr), { path = s.mainConfig })
  end
  if not mainExists then
    return fail("not_initialized", "主 Caddyfile 不存在，请先在诊断页生成初始配置", { mainConfig = s.mainConfig })
  end
  if enabled and not M.hasSnippetImport(mainRaw, s) then
    return fail("not_initialized", "主 Caddyfile 未导入站点片段目录，启用后站点不会生效", {
      mainConfig = s.mainConfig,
      snippetDir = s.snippetDir,
    })
  end

  local source = enabled and disabledPath or enabledPath
  local dest = enabled and enabledPath or disabledPath
  local sourceSymlink, symlinkErr = fs.isSymlink(source)
  if symlinkErr then
    return fail("internal", "检查站点片段符号链接失败：" .. tostring(symlinkErr), { path = source })
  end
  if sourceSymlink then
    return fail("internal", "站点片段是符号链接，拒绝移动：" .. source, { path = source })
  end
  local content, rerr = fs.read(source)
  if content == nil then
    return fail("internal", "读取站点片段失败：" .. tostring(rerr), { path = source })
  end
  if baseline ~= nil and content ~= baseline then
    return fail("conflict", "站点片段已被外部修改，请确认后再操作", {
      slug = slug,
      current = content,
      enabled = enabled,
    })
  end
  -- Enabling must not introduce an invalid snippet. Disabling is the recovery
  -- path for a broken hand-edited file, so it must work even when the snippet
  -- no longer parses; the whole-config validate after the move is the gate.
  if enabled then
    local v = caddy.validateSnippet(content)
    if not v.ok then
      local e = v.error
      return fail("validate_failed", "站点片段校验失败：" .. caddyMessage(e), {
        output = cap(caddyOutput(e), 8192),
        slug = slug,
      })
    end
  end

  local backupName, berr = fs.backup(source, enabled and "enable" or "disable", s.backupKeep)
  if backupName == nil then
    return fail("internal", "备份站点片段失败：" .. tostring(berr), { path = source })
  end
  local destDir = util.dirname(dest)
  local mok, merr = fs.mkdirp(destDir)
  if not mok then
    return fail("internal", "创建片段目录失败：" .. tostring(merr), { path = destDir })
  end
  local rok, rerr2 = fs.rename(source, dest)
  if not rok then
    return fail("internal", "移动站点片段失败：" .. tostring(rerr2), { from = source, to = dest })
  end

  local vm = caddy.validateMain(s.mainConfig)
  if not vm.ok then
    local details = { caddy = vm.error, backup = backupName, rollback = { restored = false, ok = false } }
    local backOk, backErr = fs.rename(dest, source)
    details.rollback.restored = backOk and true or false
    if not backOk then
      details.rollback.message = "移回片段失败：" .. tostring(backErr)
      return fail("rollback_failed", "整体配置校验失败，且移回片段失败", details)
    end
    local oldv = caddy.validateMain(s.mainConfig)
    details.rollback.validate = { ok = oldv.ok and true or false }
    if not oldv.ok then details.rollback.validate.message = caddyMessage(oldv.error) end
    details.rollback.ok = oldv.ok and true or false
    return fail("validate_failed", "整体配置校验失败，未改变站点状态", details)
  end

  local applyRes, relErr = M.reloadAfterChange()
  if not applyRes then
    local details = { caddy = relErr, backup = backupName, rollback = { restored = false, ok = false } }
    local backOk, backErr = fs.rename(dest, source)
    details.rollback.restored = backOk and true or false
    if not backOk then
      details.rollback.message = "移回片段失败：" .. tostring(backErr)
      return fail("rollback_failed", "Caddy 重载失败，且移回片段失败", details)
    end
    local oldv = caddy.validateMain(s.mainConfig)
    details.rollback.validate = { ok = oldv.ok and true or false }
    if not oldv.ok then
      details.rollback.validate.message = caddyMessage(oldv.error)
      details.rollback.ok = false
      return fail("rollback_failed", "已移回片段，但整体配置校验失败", details)
    end
    local rr = caddy.reload(s.mainConfig)
    details.rollback.reload = { ok = rr.ok and true or false }
    if not rr.ok then
      details.rollback.reload.message = caddyMessage(rr.error)
      details.rollback.ok = false
      return fail("rollback_failed", "已移回片段，但旧配置重载失败", details)
    end
    details.rollback.ok = true
    return fail("reload_failed", "Caddy 重载失败，已自动回滚", details)
  end
  return { slug = slug, path = dest, enabled = enabled, backup = backupName, apply = applyRes }
end

function M.deleteSiteFile(slug, baseline)
  if type(slug) ~= "string" or not util.safeSlug(slug) then
    return fail("bad_request", "站点 slug 不合法", { slug = slug })
  end
  local s = settings.load()
  local enabledPath = sites.snippetPath(slug, true)
  local disabledPath = sites.snippetPath(slug, false)
  local enabledInfo, enabledExists, enabledStatErr = fs.statChecked(enabledPath)
  if enabledStatErr then
    return fail("internal", "读取站点片段状态失败：" .. tostring(enabledStatErr), { path = enabledPath })
  end
  local disabledInfo, disabledExists, disabledStatErr = fs.statChecked(disabledPath)
  if disabledStatErr then
    return fail("internal", "读取站点片段状态失败：" .. tostring(disabledStatErr), { path = disabledPath })
  end
  if enabledExists and enabledInfo.type ~= "file" then
    return fail("internal", "站点片段路径不是普通文件", { path = enabledPath })
  end
  if disabledExists and disabledInfo.type ~= "file" then
    return fail("internal", "站点片段路径不是普通文件", { path = disabledPath })
  end
  if enabledExists and disabledExists then
    return fail("conflict", "站点片段同时存在于启用与停用目录，请先处理", { slug = slug })
  end
  local path
  if enabledExists then
    path = enabledPath
  elseif disabledExists then
    path = disabledPath
  else
    return fail("not_found", "站点片段不存在", { slug = slug })
  end
  local pathSymlink, symlinkErr = fs.isSymlink(path)
  if symlinkErr then
    return fail("internal", "检查站点片段符号链接失败：" .. tostring(symlinkErr), { path = path })
  end
  if pathSymlink then
    return fail("internal", "站点片段是符号链接，拒绝删除：" .. path, { path = path })
  end
  local content, rerr = fs.read(path)
  if content == nil then
    return fail("internal", "读取站点片段失败：" .. tostring(rerr), { path = path })
  end
  if baseline ~= nil and content ~= baseline then
    return fail("conflict", "站点片段已被外部修改，请确认后再删除", {
      slug = slug,
      current = content,
    })
  end
  local backupName, berr = fs.backup(path, "delete", s.backupKeep)
  if backupName == nil then
    return fail("internal", "备份站点片段失败：" .. tostring(berr), { path = path })
  end
  local rok, rerr2 = fs.remove(path)
  if not rok then
    return fail("internal", "删除站点片段失败：" .. tostring(rerr2), { path = path })
  end

  local vm = caddy.validateMain(s.mainConfig)
  if not vm.ok then
    local details = { caddy = vm.error, backup = backupName, rollback = { restored = false, ok = false } }
    local restored, werr = fs.writeAtomic(path, content, "0644")
    details.rollback.restored = restored and true or false
    if not restored then
      details.rollback.message = "还原片段失败：" .. tostring(werr)
      return fail("rollback_failed", "整体配置校验失败，且还原片段失败", details)
    end
    local oldv = caddy.validateMain(s.mainConfig)
    details.rollback.validate = { ok = oldv.ok and true or false }
    if not oldv.ok then details.rollback.validate.message = caddyMessage(oldv.error) end
    details.rollback.ok = oldv.ok and true or false
    return fail("validate_failed", "整体配置校验失败，未删除站点片段", details)
  end

  local applyRes, relErr = M.reloadAfterChange()
  if not applyRes then
    local details = { caddy = relErr, backup = backupName, rollback = { restored = false, ok = false } }
    local restored, werr = fs.writeAtomic(path, content, "0644")
    details.rollback.restored = restored and true or false
    if not restored then
      details.rollback.message = "还原片段失败：" .. tostring(werr)
      return fail("rollback_failed", "Caddy 重载失败，且还原片段失败", details)
    end
    local v = caddy.validateMain(s.mainConfig)
    details.rollback.validate = { ok = v.ok and true or false }
    if not v.ok then
      details.rollback.validate.message = caddyMessage(v.error)
      details.rollback.ok = false
      return fail("rollback_failed", "已还原片段，但整体配置校验失败", details)
    end
    local rr = caddy.reload(s.mainConfig)
    details.rollback.reload = { ok = rr.ok and true or false }
    if not rr.ok then
      details.rollback.reload.message = caddyMessage(rr.error)
      details.rollback.ok = false
      return fail("rollback_failed", "已还原片段，但旧配置重载失败", details)
    end
    details.rollback.ok = true
    return fail("reload_failed", "Caddy 重载失败，已自动回滚", details)
  end
  return { slug = slug, backup = backupName, apply = applyRes }
end

-- ---------------------------------------------------------------------------
-- Main Caddyfile writes and global block
-- ---------------------------------------------------------------------------

function M.writeMain(content, opts)
  opts = opts or {}
  local s = settings.load()
  if type(content) ~= "string" or content == "" then
    return fail("bad_request", "主 Caddyfile 内容不能为空")
  end
  if #content > fs.LIMIT then
    return fail("size_limit", "主 Caddyfile 超过 48 KiB 限制", { bytes = #content, limit = fs.LIMIT })
  end
  if string.find(content, "\0", 1, true) then
    return fail("bad_request", "主 Caddyfile 不能包含 NUL 字符")
  end
  local current, existed, readErr = fs.readExisting(s.mainConfig)
  if readErr then
    return fail("internal", "读取主 Caddyfile 失败：" .. tostring(readErr), { path = s.mainConfig })
  end
  if not existed then current = nil end
  -- GET /global returns raw="" for a missing file; treat "absent" as an empty
  -- baseline so the raw editor can create the file without a false conflict.
  local comparable = current or ""
  if opts.baseline ~= nil and comparable ~= opts.baseline and not opts.force then
    return fail("conflict", "主 Caddyfile 已被外部修改，请确认后再保存", {
      path = s.mainConfig,
      current = current,
    })
  end
  local backupName = nil
  if existed then
    local name, berr = fs.backup(s.mainConfig, opts.reason or "global", s.backupKeep)
    if name == nil then
      return fail("internal", "备份主 Caddyfile 失败：" .. tostring(berr), { path = s.mainConfig })
    end
    backupName = name
  end
  local dir = util.dirname(s.mainConfig)
  local mok, merr = fs.mkdirp(dir)
  if not mok then
    return fail("internal", "创建配置目录失败：" .. tostring(merr), { path = dir })
  end
  local wok, werr = fs.writeAtomic(s.mainConfig, content, "0644")
  if not wok then
    return fail("internal", "写入主 Caddyfile 失败：" .. tostring(werr), { path = s.mainConfig })
  end
  local vm = caddy.validateMain(s.mainConfig)
  if not vm.ok then
    return rollbackMainAfterValidate(s, current, vm.error, backupName)
  end
  local applyRes, relErr = M.reloadAfterChange()
  if not applyRes then
    return rollbackMainAfterReload(s, current, relErr, backupName)
  end
  return { path = s.mainConfig, bytes = #content, backup = backupName, apply = applyRes }
end

function M.mergeGlobal(raw, form)
  local parsed, perr = M.parseGlobal(raw)
  if not parsed then return nil, perr end
  if not parsed.hasMarkers then
    return fail("markers_missing", "未找到受管全局块标记，请先在诊断页生成初始配置或手动添加标记", {
      mainConfig = settings.load().mainConfig,
    })
  end
  local block, rerr = M.renderGlobal(form)
  if not block then return nil, rerr end
  return parsed.before .. block .. parsed.after
end

function M.writeGlobal(form, opts)
  opts = opts or {}
  form = form or {}
  local s = settings.load()
  local raw, existed, readErr = fs.readExisting(s.mainConfig)
  if readErr then
    return fail("internal", "读取主 Caddyfile 失败：" .. tostring(readErr), { path = s.mainConfig })
  end
  if not existed then
    return fail("not_initialized", "主 Caddyfile 不存在，请先在诊断页生成初始配置", {
      mainConfig = s.mainConfig,
    })
  end
  local newRaw, err = M.mergeGlobal(raw, form)
  if not newRaw then return nil, err end
  local res, werr = M.writeMain(newRaw, {
    baseline = opts.baseline,
    force = opts.force,
    reason = opts.reason or "global",
  })
  if not res then return nil, werr end
  local effective = {
    email = type(form.email) == "string" and util.trim(form.email) or "",
    staging = form.staging and true or false,
    extra = type(form.extra) == "string" and form.extra or "",
    admin = type(form.admin) == "string" and util.trim(form.admin) or "",
  }
  return {
    content = newRaw,
    form = effective,
    apply = res.apply,
    backup = res.backup,
    path = s.mainConfig,
    bytes = #newRaw,
  }
end

-- ---------------------------------------------------------------------------
-- Backup restore
-- ---------------------------------------------------------------------------

function M.restoreBackup(name, baseline)
  if type(name) ~= "string" or not util.safeBackupName(name) then
    return fail("bad_request", "备份名称不合法", { name = name })
  end
  local content, info, rerr = fs.readBackup(name)
  if content == nil then
    return fail("not_found", "备份不存在或无法读取：" .. tostring(info or rerr), { name = name })
  end
  if type(info) ~= "table" then
    return fail("internal", "备份信息无效", { name = name })
  end
  if info.scope == "global" then
    local res, werr = M.writeMain(content, { reason = "restore-global", force = true })
    if not res then return nil, werr end
    return {
      scope = "global",
      target = info.target,
      apply = res.apply,
      backup = res.backup,
      path = res.path,
      bytes = res.bytes,
    }
  end
  local target = info.target or ""
  local slug = string.gsub(target, "%.caddy$", "")
  if not util.safeSlug(slug) then
    return fail("bad_request", "备份的目标文件名不合法", { name = name, target = target })
  end
  local enabled = true
  if fs.exists(sites.snippetPath(slug, true)) then
    enabled = true
  elseif fs.exists(sites.snippetPath(slug, false)) then
    enabled = false
  end
  local res, werr = M.writeSite({
    slug = slug,
    content = content,
    enabled = enabled,
    baseline = baseline,
    force = true,
    allowCreate = true,
    reason = "restore",
  })
  if not res then return nil, werr end
  return {
    scope = "site",
    slug = slug,
    target = target,
    enabled = res.enabled,
    apply = res.apply,
    backup = res.backup,
  }
end

-- ---------------------------------------------------------------------------
-- Initialization and reload
-- ---------------------------------------------------------------------------

function M.init(overwrite)
  local s = settings.load()
  local created = util.array({})
  local seen = {}
  local dirs = {
    util.dirname(s.mainConfig),
    s.snippetDir,
    s.disabledDir,
    s.sitesRoot,
    s.backupsDir,
  }
  for _, dir in ipairs(dirs) do
    if type(dir) == "string" and dir ~= "" and not seen[dir] then
      seen[dir] = true
      if not fs.isDir(dir) then
        local ok, err = fs.mkdirp(dir)
        if not ok then
          return fail("internal", "创建目录失败：" .. tostring(err), { path = dir })
        end
        created[#created + 1] = dir
      end
    end
  end

  local st = fs.stat(s.mainConfig)
  local existsNonEmpty = st ~= nil and st.type == "file" and (st.size or 0) > 0
  if existsNonEmpty and not overwrite then
    return fail("conflict", "主 Caddyfile 已存在且非空；如确认覆盖请再次确认", {
      mainConfig = s.mainConfig,
    })
  end

  local initial = M.initialConfig()
  local res, werr = M.writeMain(initial, { force = true, reason = "init" })
  if not res then return nil, werr end
  -- Establish the drift baseline for first-run installs.
  local parsed = M.parseGlobal(initial)
  if parsed and parsed.hasMarkers then
    local modelJson = util.jsonEncode({
      email = parsed.email or "",
      staging = parsed.staging and true or false,
      extra = parsed.extra or "",
      admin = parsed.admin or "",
    })
    local okMeta, metaErr = pcall(function()
      local contentOk, contentErr = store.metaSet("global.last_content", initial)
      if not contentOk then error(contentErr or "meta write failed") end
      if type(modelJson) == "string" then
        local modelOk, modelErr = store.metaSet("global.model", modelJson)
        if not modelOk then error(modelErr or "meta write failed") end
      end
    end)
    if not okMeta then
      print("init meta baseline failed: " .. tostring(metaErr))
    end
  end
  return {
    written = true,
    mainConfig = s.mainConfig,
    createdDirs = created,
    backup = res.backup,
    apply = res.apply,
  }
end

function M.reloadCurrent()
  local s = settings.load()
  local st = fs.stat(s.mainConfig)
  if not st or st.type ~= "file" then
    return fail("not_initialized", "主 Caddyfile 不存在，请先在诊断页生成初始配置", {
      mainConfig = s.mainConfig,
    })
  end
  local v = caddy.validateMain(s.mainConfig)
  local validate = { ok = v.ok and true or false }
  if not v.ok then
    validate.message = caddyMessage(v.error)
    return fail("reload_failed", "配置校验失败，未重载", {
      validate = validate,
      caddy = v.error,
      output = cap(caddyOutput(v.error), 8192),
    })
  end
  local r = caddy.reload(s.mainConfig)
  local reload = { ok = r.ok and true or false }
  if not r.ok then
    reload.message = caddyMessage(r.error)
    return fail("reload_failed", "Caddy 重载失败", {
      validate = validate,
      reload = reload,
      caddy = r.error,
      output = cap(caddyOutput(r.error), 8192),
    })
  end
  return { validate = validate, reload = reload }
end

return M
