-- Thin wrapper over host.services with Chinese error hints.
local util = require("util")

local M = {}

local function clip(s, limit)
  s = tostring(s or "")
  if #s > limit then return s:sub(1, limit) end
  return s
end

-- Map a host.service error message to a plugin error code plus Chinese hint.
function M.mapError(message)
  local raw = clip(message, 800)
  -- Drop the Lua chunk prefix (".../services.lua:52: ") from pcall errors.
  raw = raw:gsub("^.-%.lua:%d+: ", "", 1)
  local low = string.lower(raw)
  local code, hint
  local function has(needle)
    return string.find(low, needle, 1, true) ~= nil
  end

  if has("not authorized") or has("no service grant") or has("no capability grant") or has("forbidden") then
    code = "grant_missing"
    hint = "服务授权不足：部署授权文件未包含该单元/操作"
  elseif has("logs_unavailable") or has("journal") then
    code = "journal_unavailable"
    hint = "日志不可用：宿主账号需加入 systemd-journal 组"
  elseif has("host.services.logs") and (has("permission") or has("denied") or has("access denied")) then
    code = "journal_unavailable"
    hint = "日志不可用：宿主账号需加入 systemd-journal 组"
  elseif has("permission") or has("sudoers") or has("sudo") or has("elevat") then
    code = "privilege_missing"
    hint = "权限不足：宿主账号缺少 sudoers 规则"
  elseif has("not_found") or has("not found") or string.find(raw, "服务不存在", 1, true) then
    code = "not_found"
    hint = "服务不存在"
  else
    code = "service_error"
    hint = "服务操作失败"
  end

  local text = hint
  if raw ~= "" then text = hint .. "（" .. raw .. "）" end
  return { code = code, message = clip(text, 2000) }
end

local function serviceError(message)
  return { code = "service_error", message = clip(message, 2000) }
end

function M.get(unit)
  if type(unit) ~= "string" or unit == "" then return nil, serviceError("服务单元无效") end
  local ok, result = pcall(function() return host.services.get(unit) end)
  if not ok then return nil, M.mapError(result) end
  if type(result) ~= "table" then return nil, serviceError("服务状态返回无效") end
  return result
end

function M.list()
  local ok, result = pcall(function() return host.services.list() end)
  if not ok then return nil, M.mapError(result) end
  local items = util.array({})
  if type(result) == "table" then
    for _, item in ipairs(result) do
      if type(item) == "table" then items[#items + 1] = item end
    end
  end
  return items
end

local function action(name, unit)
  if type(unit) ~= "string" or unit == "" then return nil, serviceError("服务单元无效") end
  local ok, result = pcall(function() return host.services[name](unit) end)
  if not ok then return nil, M.mapError(result) end
  if result == false or result == nil then
    return nil, serviceError("服务" .. name .. "操作未成功")
  end
  return true
end

function M.start(unit)
  return action("start", unit)
end

function M.stop(unit)
  return action("stop", unit)
end

function M.restart(unit)
  return action("restart", unit)
end

function M.logs(unit, lines)
  if type(unit) ~= "string" or unit == "" then return nil, serviceError("服务单元无效") end
  local n = tonumber(lines)
  if not n or n % 1 ~= 0 or n < 1 then n = 200 end
  if n > 2000 then n = 2000 end
  local ok, result = pcall(function() return host.services.logs(unit, n) end)
  if not ok then return nil, M.mapError(result) end
  local items = util.array({})
  if type(result) == "table" then
    for _, line in ipairs(result) do
      if type(line) == "string" then items[#items + 1] = line end
    end
  end
  return items
end

function M.state(unit)
  local detail, err = M.get(unit)
  if not detail then return nil, err end
  local state = detail.state
  if state == "running" or state == "stopped" or state == "failed"
    or state == "completed" or state == "unknown" then
    return state
  end
  return "unknown"
end

return M
