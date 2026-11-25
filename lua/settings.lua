-- settings.lua — effective plugin configuration.
-- host.config.all() already merges manifest defaults with saved values, but we
-- still defensively apply defaults and validation because config can be edited
-- at runtime and malformed values must never break a request.
local util = require("util")

local M = {}

M.DEFAULTS = {
  caddyBinary = "/opt/caddy/caddy",
  mainConfig = "/opt/caddy/config/Caddyfile",
  snippetDir = "/opt/caddy/config/conf.d",
  sitesRoot = "/opt/caddy/sites",
  serviceUnit = "caddy.service",
  logLines = 500,
  certProbeHours = 6,
  backupKeep = 100,
  metricsPeriodic = false,
}

local LABELS = {
  caddyBinary = "Caddy 可执行文件",
  mainConfig = "主 Caddyfile",
  snippetDir = "站点片段目录",
  disabledDir = "停用片段目录",
  sitesRoot = "站点根目录",
  serviceUnit = "服务单元",
  logLines = "日志轮询行数",
  certProbeHours = "证书探测间隔（小时）",
  backupKeep = "备份保留数",
  metricsPeriodic = "每 60 秒采集运行快照",
}

local ORDER = {
  "caddyBinary",
  "mainConfig",
  "snippetDir",
  "sitesRoot",
  "serviceUnit",
  "logLines",
  "certProbeHours",
  "backupKeep",
  "metricsPeriodic",
}

-- systemd unit names may contain ':', '_', '.', '@', '-'.
local UNIT_PATTERN = "^[A-Za-z0-9:_.@%-]+%.service$"

function M.label(key)
  return LABELS[key] or tostring(key)
end

local function makeEffective(values, warnings)
  local dataDir = type(host.dataDir) == "string" and host.dataDir or ""
  local snippetDir = values.snippetDir
  local raw = {
    caddyBinary = values.caddyBinary,
    mainConfig = values.mainConfig,
    snippetDir = snippetDir,
    sitesRoot = values.sitesRoot,
    serviceUnit = values.serviceUnit,
    logLines = values.logLines,
    certProbeHours = values.certProbeHours,
    backupKeep = values.backupKeep,
    metricsPeriodic = values.metricsPeriodic,
  }
  return {
    caddyBinary = values.caddyBinary,
    mainConfig = values.mainConfig,
    snippetDir = snippetDir,
    disabledDir = snippetDir .. ".disabled",
    sitesRoot = values.sitesRoot,
    serviceUnit = values.serviceUnit,
    logLines = values.logLines,
    certProbeHours = values.certProbeHours,
    backupKeep = values.backupKeep,
    metricsPeriodic = values.metricsPeriodic,
    dataDir = dataDir,
    backupsDir = dataDir .. "/backups",
    warnings = warnings,
    raw = raw,
    manifestDefaults = M.DEFAULTS,
  }
end

local function build()
  local warnings = util.array({})
  local function addWarning(text)
    warnings[#warnings + 1] = text
  end

  local ok, all = pcall(host.config.all)
  if not ok or type(all) ~= "table" then
    all = {}
    addWarning("无法读取插件配置，已使用默认值")
  end

  local function readPath(key)
    local default = M.DEFAULTS[key]
    local value = all[key]
    if value == nil then return default end
    if type(value) ~= "string" then
      addWarning("配置项「" .. M.label(key) .. "」不是字符串，已使用默认值")
      return default
    end
    value = util.trim(value)
    if value == "" then return default end
    if not util.isAbsolute(value)
      or value:find("\0", 1, true)
      or value:find("\n", 1, true)
      or value:find("\r", 1, true) then
      addWarning("配置项「" .. M.label(key) .. "」必须是绝对路径且不能包含换行，已使用默认值")
      return default
    end
    return value
  end

  local function readInt(key, minimum, maximum)
    local default = M.DEFAULTS[key]
    local value = all[key]
    if value == nil then return default end
    local number = tonumber(value)
    if number == nil or number ~= number then
      addWarning("配置项「" .. M.label(key) .. "」不是有效数字，已使用默认值")
      return default
    end
    number = util.round(number)
    if number < minimum then number = minimum end
    if number > maximum then number = maximum end
    return number
  end

  local caddyBinary = readPath("caddyBinary")
  local mainConfig = readPath("mainConfig")
  local snippetDir = readPath("snippetDir")
  local sitesRoot = readPath("sitesRoot")
  local logLines = readInt("logLines", 100, 2000)
  local certProbeHours = readInt("certProbeHours", 1, 168)
  local backupKeep = readInt("backupKeep", 10, 1000)

  -- Trailing slashes make "dir/" and "dir" different strings for backups and
  -- comparison; normalize here (but keep the filesystem root "/").
  while #snippetDir > 1 and snippetDir:sub(-1) == "/" do
    snippetDir = snippetDir:sub(1, -2)
  end

  local serviceUnit = M.DEFAULTS.serviceUnit
  local rawUnit = all.serviceUnit
  if rawUnit ~= nil then
    if type(rawUnit) ~= "string" then
      addWarning("配置项「" .. M.label("serviceUnit") .. "」不是字符串，已使用默认值")
    else
      local candidate = util.trim(rawUnit)
      if candidate ~= "" and not candidate:match(UNIT_PATTERN) then
        addWarning("配置项「" .. M.label("serviceUnit") .. "」不是有效的 systemd 服务单元，已使用默认值")
      elseif candidate ~= "" then
        serviceUnit = candidate
      end
    end
  end

  return makeEffective({
    caddyBinary = caddyBinary,
    mainConfig = mainConfig,
    snippetDir = snippetDir,
    sitesRoot = sitesRoot,
    serviceUnit = serviceUnit,
    logLines = logLines,
    certProbeHours = certProbeHours,
    backupKeep = backupKeep,
    metricsPeriodic = all.metricsPeriodic == true,
  }, warnings)
end

-- Never throws: on any unexpected failure fall back to defaults with a warning.
function M.load()
  local ok, result = pcall(build)
  if ok and type(result) == "table" then return result end
  local warnings = util.array({ "读取插件配置失败，已使用默认值" })
  local defaults = {
    caddyBinary = M.DEFAULTS.caddyBinary,
    mainConfig = M.DEFAULTS.mainConfig,
    snippetDir = M.DEFAULTS.snippetDir,
    sitesRoot = M.DEFAULTS.sitesRoot,
    serviceUnit = M.DEFAULTS.serviceUnit,
    logLines = M.DEFAULTS.logLines,
    certProbeHours = M.DEFAULTS.certProbeHours,
    backupKeep = M.DEFAULTS.backupKeep,
    metricsPeriodic = M.DEFAULTS.metricsPeriodic,
  }
  return makeEffective(defaults, warnings)
end

function M.effective()
  local config = M.load()
  local out = util.array({})
  for i = 1, #ORDER do
    local key = ORDER[i]
    out[#out + 1] = {
      key = key,
      label = M.label(key),
      value = config[key],
    }
  end
  return out
end

return M
