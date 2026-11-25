-- http.lua — JSON response envelope, request body limits, typed accessors.
-- Every route handler is wrapped by M.wrap so exceptions become the standard
-- error envelope instead of the host's raw 500.
local util = require("util")

local M = {}

M.codeStatus = {
  bad_request = 400,
  invalid_json = 400,
  invalid_model = 400,
  size_limit = 400,
  validate_failed = 400,
  not_found = 404,
  conflict = 409,
  markers_missing = 409,
  not_running = 409,
  not_initialized = 503,
  caddy_missing = 503,
  privilege_missing = 503,
  journal_unavailable = 503,
  service_error = 503,
  reload_failed = 503,
  rollback_failed = 500,
  internal = 500,
}

local BODY_LIMIT = 1024 * 1024

local function jsonHeaders()
  return {
    ["content-type"] = "application/json; charset=utf-8",
    ["cache-control"] = "no-store",
  }
end

local FALLBACK_INTERNAL = '{"ok":false,"error":{"code":"internal","message":"internal error"}}'

function M.fail(code, message, details, status)
  if type(code) ~= "string" or code == "" then code = "internal" end
  if type(message) ~= "string" then
    message = tostring(message or "请求失败")
  end
  local err = { code = code, message = message }
  if details ~= nil then err.details = details end
  local body = util.jsonEncode({ ok = false, error = err })
  if body == nil then body = FALLBACK_INTERNAL end
  local httpStatus = tonumber(status) or M.codeStatus[code] or 500
  return {
    status = httpStatus,
    headers = jsonHeaders(),
    body = body,
  }
end

function M.ok(data)
  local payload = { ok = true }
  if data ~= nil then payload.data = data end
  local body = util.jsonEncode(payload)
  if body == nil then
    return M.fail("internal", "插件内部错误", nil, 500)
  end
  return {
    status = 200,
    headers = jsonHeaders(),
    body = body,
  }
end

function M.text(body, headers)
  local out = {
    ["content-type"] = "text/plain; charset=utf-8",
    ["cache-control"] = "no-store",
  }
  if type(headers) == "table" then
    for key, value in pairs(headers) do
      if type(key) == "string" then out[key] = value end
    end
  end
  return {
    status = 200,
    headers = out,
    body = type(body) == "string" and body or "",
  }
end

-- Decode a JSON object body. Returns obj, nil or nil, errorResponse.
function M.body(request, maxBytes)
  local limit = tonumber(maxBytes) or BODY_LIMIT
  if limit ~= limit or limit < 0 then limit = BODY_LIMIT end
  local raw = nil
  if type(request) == "table" then raw = request.body end
  if raw == nil or raw == "" then return {}, nil end
  if type(raw) ~= "string" then
    return nil, M.fail("bad_request", "请求体必须是 JSON 对象", nil, 400)
  end
  if #raw > limit then
    return nil, M.fail("size_limit", "请求体超过 " .. tostring(limit) .. " 字节限制", { maxBytes = limit }, 400)
  end
  -- pcall directly so JSON "null" is reported as bad_request, not invalid_json.
  local ok, decoded = pcall(host.json.decode, raw)
  if not ok then
    -- pcall prefixes the message with the module chunk path; do not expose it.
    local message = tostring(decoded):gsub("^.-%.lua:%d+: ", "", 1)
    return nil, M.fail("invalid_json", "请求体不是有效的 JSON", { error = message }, 400)
  end
  -- JSON arrays decode to tables with consecutive numeric keys and no array
  -- marker. Reject non-empty arrays; an empty [] is indistinguishable from {}.
  local isObject = type(decoded) == "table" and not util.isArray(decoded)
  if isObject then
    local hasNumericKey = false
    for key in pairs(decoded) do
      if type(key) == "number" then
        hasNumericKey = true
        break
      end
    end
    isObject = not hasNumericKey
  end
  if not isObject then
    return nil, M.fail("bad_request", "请求体必须是 JSON 对象", nil, 400)
  end
  return decoded, nil
end

function M.queryString(request, name, default)
  if type(request) ~= "table" or type(request.query) ~= "table" then
    return default
  end
  local value = request.query[name]
  if type(value) == "table" then value = value[1] end
  if type(value) ~= "string" or value == "" then return default end
  return value
end

function M.queryInt(request, name, default, minimum, maximum)
  local raw = M.queryString(request, name, nil)
  if raw == nil then return default, nil end
  if not raw:match("^%-?%d+$") then
    return nil, M.fail("bad_request", "查询参数 " .. name .. " 必须是整数", { field = name }, 400)
  end
  local value = tonumber(raw)
  if value == nil then
    return nil, M.fail("bad_request", "查询参数 " .. name .. " 必须是整数", { field = name }, 400)
  end
  if (minimum ~= nil and value < minimum) or (maximum ~= nil and value > maximum) then
    local range = ""
    if minimum ~= nil and maximum ~= nil then
      range = "（" .. tostring(minimum) .. "-" .. tostring(maximum) .. "）"
    end
    return nil, M.fail("bad_request", "查询参数 " .. name .. " 超出范围" .. range, {
      field = name,
      min = minimum,
      max = maximum,
    }, 400)
  end
  return value, nil
end

function M.str(tbl, key)
  if type(tbl) ~= "table" then return nil end
  local value = tbl[key]
  if type(value) == "string" then return value end
  return nil
end

function M.bool(tbl, key, default)
  if type(tbl) ~= "table" then return default end
  local value = tbl[key]
  if value == nil then return default end
  if type(value) == "boolean" then return value end
  return nil
end

function M.int(tbl, key, default)
  if type(tbl) ~= "table" then return default end
  local value = tbl[key]
  if value == nil then return default end
  if type(value) == "number" and value == math.floor(value) then return value end
  return nil
end

function M.list(tbl, key)
  if type(tbl) ~= "table" then return nil end
  local value = tbl[key]
  if type(value) == "table" then return value end
  return nil
end

function M.wrap(handler)
  if type(handler) ~= "function" then
    return function()
      print("route error: handler is not a function")
      return M.fail("internal", "插件内部错误", nil, 500)
    end
  end
  return function(request)
    local ok, response = pcall(handler, request)
    if not ok then
      print("route error: " .. tostring(response))
      return M.fail("internal", "插件内部错误", nil, 500)
    end
    if type(response) ~= "table" then
      print("route error: handler returned " .. type(response))
      return M.fail("internal", "插件内部错误", nil, 500)
    end
    if response.status ~= nil then
      local status = response.status
      if type(status) ~= "number" or status ~= math.floor(status) or status < 100 or status > 599 then
        print("route error: handler returned an invalid status")
        return M.fail("internal", "插件内部错误", nil, 500)
      end
    end
    if response.body ~= nil and type(response.body) ~= "string" then
      print("route error: handler returned a non-string body")
      return M.fail("internal", "插件内部错误", nil, 500)
    end
    if response.headers ~= nil and type(response.headers) ~= "table" then
      print("route error: handler returned invalid headers")
      return M.fail("internal", "插件内部错误", nil, 500)
    end
    if response.status == nil then response.status = 200 end
    if response.headers == nil then response.headers = {} end
    return response
  end
end

return M
