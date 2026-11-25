-- Thin wrapper over host.services with Chinese error hints.
local util = require("util")

local M = {}

local function clip(s, limit)
  s = tostring(s or "")
  if #s > limit then return s:sub(1, limit) end
  return s
end

-- Host service errors are formatted as host.services.<method>: <code>: <message>.
function M.mapError(message)
  local raw = clip(message, 800)
  -- Drop the Lua chunk prefix (".../services.lua:52: ") from pcall errors.
  raw = raw:gsub("^.-%.lua:%d+: ", "", 1)
  local code, hint
  local method, hostCode = raw:match("^host%.services%.(%w+): ([%w_]+):")

  if hostCode == "logs_unavailable" then
    code = "journal_unavailable"
    hint = "日志不可用：请检查宿主环境中的 journalctl"
  elseif method == "logs" and hostCode == "permission" then
    code = "journal_unavailable"
    hint = "日志读取权限不足：请检查宿主账号的 systemd-journal 组权限"
  elseif hostCode == "permission" then
    code = "privilege_missing"
    if method == "start" or method == "stop" or method == "restart" then
      hint = "服务操作权限不足：请检查宿主账号的权限与系统 sudoers 配置"
    else
      hint = "服务查询权限不足：请检查宿主账号的 systemd 读取权限"
    end
  elseif hostCode == "not_found" then
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
  local ok, result = pcall(function() return host.services[name](unit, { sudo = true }) end)
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
