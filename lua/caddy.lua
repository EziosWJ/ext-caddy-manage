-- caddy.lua — thin host.process.exec wrapper for the Caddy binary.
-- All calls use explicit timeouts from design §11 and never echo stdin (a
-- password may be passed on stdin to hash-password).
local util = require("util")
local settings = require("settings")

local M = {}

local MESSAGE_LIMIT = 8192
local STREAM_LIMIT = 16384

local function cap(text, limit)
  if type(text) ~= "string" then return "" end
  if #text > limit then return text:sub(1, limit) end
  return text
end

local function firstNonEmptyLine(text)
  if type(text) ~= "string" or text == "" then return "" end
  local lines = util.splitLines(text)
  for i = 1, #lines do
    local line = util.trim(lines[i])
    if line ~= "" then return line end
  end
  return ""
end

-- Returns {ok, stdout, stderr, truncated} or nil, errorTable.
local function run(args, stdin, timeoutMs)
  timeoutMs = timeoutMs or 30000
  local config = settings.load()
  local program = config.caddyBinary
  local options = { timeoutMs = timeoutMs }
  if stdin ~= nil then options.stdin = stdin end

  local ok, result, err = pcall(host.process.exec, program, args, options)
  if not ok then
    return nil, {
      code = "caddy_missing",
      message = "无法执行 Caddy：" .. tostring(result),
      details = { program = program },
    }
  end
  if not result then
    return nil, {
      code = "caddy_missing",
      message = "无法执行 Caddy：" .. tostring(err),
      details = { program = program },
    }
  end
  if result.timedOut then
    return nil, {
      code = "timeout",
      message = "Caddy 命令超时（" .. tostring(timeoutMs) .. " ms）",
      details = { program = program, timeoutMs = timeoutMs },
    }
  end

  local stdout = type(result.stdout) == "string" and result.stdout or ""
  local stderr = type(result.stderr) == "string" and result.stderr or ""
  local exitCode = tonumber(result.exitCode) or -1
  local stdoutTruncated = result.stdoutTruncated == true
  local stderrTruncated = result.stderrTruncated == true
  local waitError = type(result.error) == "string" and result.error or ""

  if exitCode ~= 0 or waitError ~= "" then
    local message = firstNonEmptyLine(stderr)
    if message == "" then message = firstNonEmptyLine(stdout) end
    if message == "" then message = waitError end
    if message == "" then message = "Caddy 命令失败" end
    return nil, {
      code = "failed",
      message = cap(message, MESSAGE_LIMIT),
      details = {
        exitCode = exitCode,
        stderr = cap(stderr, STREAM_LIMIT),
        stdout = cap(stdout, STREAM_LIMIT),
        stderrTruncated = stderrTruncated,
        stdoutTruncated = stdoutTruncated,
      },
    }
  end

  return {
    ok = true,
    stdout = stdout,
    stderr = stderr,
    truncated = (stdoutTruncated or stderrTruncated),
  }
end

function M.version()
  local result, err = run({ "version" }, nil, 5000)
  if not result then
    return { ok = false, version = "", raw = "", error = err }
  end
  local line = firstNonEmptyLine(result.stdout)
  local version = line:match("^(%S+)") or ""
  return { ok = true, version = version, raw = result.stdout }
end

function M.modules()
  local items = util.array({})
  local result, err = run({ "list-modules" }, nil, 10000)
  if not result then
    return { ok = false, items = items, truncated = false, error = err }
  end
  local lines = util.splitLines(result.stdout)
  for i = 1, #lines do
    local item = util.trim(lines[i])
    if item ~= "" then items[#items + 1] = item end
  end
  return { ok = true, items = items, truncated = result.truncated == true }
end

function M.validateSnippet(text)
  if type(text) ~= "string" then
    return {
      ok = false,
      error = { code = "bad_request", message = "片段内容必须是字符串", details = { field = "content" } },
    }
  end
  local result, err = run({ "validate", "--config", "-", "--adapter", "caddyfile" }, text, 15000)
  if not result then return { ok = false, error = err } end
  return { ok = true }
end

function M.validateMain(path)
  if type(path) ~= "string" or path == "" then
    return {
      ok = false,
      error = { code = "bad_request", message = "主配置文件路径无效", details = { field = "mainConfig" } },
    }
  end
  local result, err = run({ "validate", "--config", path, "--adapter", "caddyfile" }, nil, 15000)
  if not result then return { ok = false, error = err } end
  return { ok = true }
end

function M.reload(path)
  if type(path) ~= "string" or path == "" then
    return {
      ok = false,
      error = { code = "bad_request", message = "主配置文件路径无效", details = { field = "mainConfig" } },
    }
  end
  local result, err = run({ "reload", "--config", path, "--adapter", "caddyfile" }, nil, 20000)
  if not result then return { ok = false, error = err } end
  return { ok = true }
end

function M.fmt(text)
  if type(text) ~= "string" then
    return {
      ok = false,
      formatted = "",
      error = { code = "bad_request", message = "格式化内容必须是字符串", details = { field = "content" } },
    }
  end
  local result, err = run({ "fmt", "-" }, text, 10000)
  if not result then
    return { ok = false, formatted = "", error = err }
  end
  local formatted = result.stdout
  -- Defensive: an empty stdout with exit 0 would otherwise wipe the editor
  -- content; keep the input in that odd case.
  if formatted == "" and text ~= "" then formatted = text end
  return { ok = true, formatted = formatted }
end

function M.hashPassword(password)
  if type(password) ~= "string" or #password < 1 or #password > 1024
    or password:find("\n", 1, true) or password:find("\r", 1, true)
    or password:find("\0", 1, true) then
    return {
      ok = false,
      hash = "",
      error = {
        code = "hash_failed",
        message = "密码格式无效（1-1024 字节，且不能包含换行）",
        details = { field = "password" },
      },
    }
  end
  local result, err = run({ "hash-password" }, password .. "\n", 20000)
  if not result then
    -- Never include stdin, streams or the password in the error: only the
    -- failure stage and exit code are safe to surface.
    local details = { cause = err.code }
    if type(err.details) == "table" and err.details.exitCode ~= nil then
      details.exitCode = err.details.exitCode
    end
    return {
      ok = false,
      hash = "",
      error = {
        code = "hash_failed",
        message = "密码哈希失败",
        details = details,
      },
    }
  end
  local hash = util.trim(result.stdout)
  if not hash:match("^%$2[abxy]%$%d%d%$[%w./]+$") then
    return {
      ok = false,
      hash = "",
      error = {
        code = "hash_failed",
        message = "密码哈希失败",
        details = { stage = "output" },
      },
    }
  end
  return { ok = true, hash = hash }
end

return M
