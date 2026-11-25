-- fs.lua — file helpers over io + direct-argv host.process.exec.
-- No mkdir/readdir/stat exist in Lua, so directory work goes through argv
-- commands (never a shell); writes use a same-directory temp file + rename.
local util = require("util")

local M = {}

M.LIMIT = 48 * 1024
M.dataDir = host.dataDir
M.backupsDir = host.dataDir .. "/backups"

local tmpSeq = 0
local EXEC_TIMEOUT = 5000

local function run(program, args, timeoutMs)
  local ok, result, err = pcall(host.process.exec, program, args, { timeoutMs = timeoutMs or EXEC_TIMEOUT })
  if not ok then
    return nil, "无法执行 " .. program .. "：" .. tostring(result)
  end
  if not result then
    return nil, "无法执行 " .. program .. "：" .. tostring(err)
  end
  return result
end

local function firstLine(text)
  if type(text) ~= "string" or text == "" then return "" end
  local lines = util.splitLines(text)
  for i = 1, #lines do
    local line = util.trim(lines[i])
    if line ~= "" then return line end
  end
  return ""
end

function M.read(path)
  if type(path) ~= "string" or path == "" then
    return nil, "无效的文件路径"
  end
  local file, openErr = io.open(path, "rb")
  if not file then
    return nil, "无法读取文件：" .. tostring(openErr or path)
  end
  local content, readErr = file:read("*a")
  file:close()
  if content == nil then
    -- io.open succeeds on a directory on Linux; the read is what fails.
    return nil, "无法读取文件（可能是目录）：" .. tostring(readErr or path)
  end
  return content
end

function M.stat(path)
  if type(path) ~= "string" or path == "" then
    return nil, "无效的文件路径"
  end
  -- Force the C locale: GNU stat localizes both error text and %F types, and
  -- this module relies on "No such file" / "regular file".
  local result, err = run("env", { "LC_ALL=C", "stat", "-L", "-c", "%F\t%s\t%Y", "--", path }, EXEC_TIMEOUT)
  if not result then return nil, err end
  if result.timedOut then return nil, "读取文件状态超时：" .. path end
  if result.exitCode ~= 0 then
    local message = firstLine(result.stderr)
    if message == "" then message = "无法读取文件状态：" .. path end
    return nil, message
  end
  local line = firstLine(result.stdout)
  local rawType, size, mtime = line:match("^(.-)\t(%d+)\t(%-?%d+)$")
  if not rawType then return nil, "无法解析文件状态：" .. path end
  local kind = "other"
  if rawType == "directory" then
    kind = "directory"
  elseif rawType == "regular file" or rawType == "regular empty file" then
    kind = "file"
  end
  return {
    type = kind,
    size = tonumber(size) or 0,
    mtime = tonumber(mtime) or 0,
  }
end

local function isMissingMessage(message)
  local text = tostring(message or "")
  return text:lower():find("no such file", 1, true) ~= nil
    or text:find("ENOENT", 1, true) ~= nil
end

-- Distinguish "absent" from "stat failed" (permission, EIO, missing tool).
-- Returns info|nil, exists, err. err is non-nil only for a real failure.
function M.statChecked(path)
  local info, err = M.stat(path)
  if info then return info, true, nil end
  if isMissingMessage(err) then return nil, false, nil end
  return nil, false, err or "无法读取文件状态"
end

-- Read a path that must be a regular file when it exists. Returns
-- content|nil, exists, err. A nil content with exists=true is a read failure.
function M.readExisting(path)
  local info, exists, statErr = M.statChecked(path)
  if statErr then return nil, false, statErr end
  if not exists then return nil, false, nil end
  if info.type ~= "file" then
    return nil, true, "路径不是普通文件：" .. tostring(path)
  end
  local content, readErr = M.read(path)
  if content == nil then
    return nil, true, "无法读取文件：" .. tostring(readErr or path)
  end
  return content, true, nil
end

function M.exists(path)
  local info = M.stat(path)
  return info ~= nil
end

function M.isDir(path)
  local info = M.stat(path)
  return info ~= nil and info.type == "directory"
end

local function parseFindLines(text)
  local out = util.array({})
  if type(text) ~= "string" or text == "" then return out end
  for _, line in ipairs(util.splitLines(text)) do
    local name, size, mtime = line:match("^([^\t]+)\t(%d+)\t([%d%.]+)$")
    if name then
      out[#out + 1] = {
        name = name,
        size = tonumber(size) or 0,
        mtime = tonumber(mtime) or 0,
      }
    end
  end
  return out
end

-- Regular *.caddy files directly inside dir; empty array when dir is absent.
function M.list(dir)
  if type(dir) ~= "string" or dir == "" then return util.array({}) end
  local result = run("env", {
    "LC_ALL=C", "find", "-L", dir, "-maxdepth", "1", "-type", "f", "-name", "*.caddy",
    "-printf", "%f\t%s\t%T@\n",
  }, EXEC_TIMEOUT)
  if not result or result.timedOut or result.exitCode ~= 0 then
    return util.array({})
  end
  return parseFindLines(result.stdout)
end

-- Every regular file directly inside dir (used for the backups directory).
local function listFiles(dir)
  if type(dir) ~= "string" or dir == "" then return util.array({}) end
  local result = run("env", {
    "LC_ALL=C", "find", "-L", dir, "-maxdepth", "1", "-type", "f",
    "-printf", "%f\t%s\t%T@\n",
  }, EXEC_TIMEOUT)
  if not result or result.timedOut or result.exitCode ~= 0 then
    return util.array({})
  end
  return parseFindLines(result.stdout)
end

function M.mkdirp(path)
  if type(path) ~= "string" or path == "" or path:find("\0", 1, true) then
    return false, "无效的目录路径"
  end
  local result, err = run("mkdir", { "-p", "--", path }, EXEC_TIMEOUT)
  if not result then return false, err end
  if result.timedOut then return false, "创建目录超时：" .. path end
  if result.exitCode ~= 0 then
    local message = firstLine(result.stderr)
    if message == "" then message = "无法创建目录：" .. path end
    return false, message
  end
  return true
end

function M.isSymlink(path)
  if type(path) ~= "string" or path == "" then return false, "无效的文件路径" end
  local result, err = run("readlink", { "--", path }, EXEC_TIMEOUT)
  if not result then return false, err end
  if result.timedOut then return false, "检查符号链接超时：" .. path end
  if result.exitCode == 0 then return true end
  if result.exitCode == 1 then return false end
  return false, "无法检查符号链接：" .. path
end

-- Atomic write: temp file in the target directory, flush/close, chmod, rename.
-- The temp file is removed on every failure path so no partial file is visible.
function M.writeAtomic(path, content, mode)
  if type(path) ~= "string" or path == "" then
    return false, "无效的文件路径"
  end
  if type(content) ~= "string" then
    return false, "写入内容必须是字符串"
  end
  mode = mode or "0644"
  if type(mode) ~= "string" or not mode:match("^0?[0-7][0-7][0-7]$") then
    return false, "无效的文件模式"
  end
  local symlink, symlinkErr = M.isSymlink(path)
  if symlinkErr then return false, symlinkErr end
  if symlink then
    return false, "目标文件是符号链接，拒绝写入：" .. path
  end

  tmpSeq = tmpSeq + 1
  local temporary = util.dirname(path) .. "/.ecm-tmp-" .. tostring(os.time()) .. "-" .. tostring(tmpSeq)
  local file, openErr = io.open(temporary, "wb")
  if not file then
    return false, "无法创建临时文件：" .. tostring(openErr or temporary)
  end
  local function cleanup()
    pcall(os.remove, temporary)
  end

  local wrote, writeErr = file:write(content)
  if not wrote then
    file:close()
    cleanup()
    return false, "写入临时文件失败：" .. tostring(writeErr)
  end
  local flushed, flushErr = file:flush()
  if not flushed then
    file:close()
    cleanup()
    return false, "刷新临时文件失败：" .. tostring(flushErr)
  end
  local closed, closeErr = file:close()
  if not closed then
    cleanup()
    return false, "关闭临时文件失败：" .. tostring(closeErr)
  end

  local chmodResult, chmodErr = run("chmod", { mode, "--", temporary }, EXEC_TIMEOUT)
  if not chmodResult then
    cleanup()
    return false, chmodErr
  end
  if chmodResult.timedOut or chmodResult.exitCode ~= 0 then
    local message = firstLine(chmodResult.stderr)
    cleanup()
    if message == "" then message = "无法设置文件权限：" .. path end
    return false, message
  end

  local renamed, renameErr = os.rename(temporary, path)
  if not renamed then
    cleanup()
    return false, "无法替换文件：" .. tostring(renameErr)
  end
  return true
end

function M.remove(path)
  if type(path) ~= "string" or path == "" then
    return false, "无效的文件路径"
  end
  local ok, err = os.remove(path)
  if ok then return true end
  local message = tostring(err or "")
  -- gopher-lua's os.remove does not return an errno; match the Linux text.
  if message:find("no such file", 1, true) or message:find("ENOENT", 1, true) then
    return true
  end
  return false, "无法删除文件：" .. message
end

function M.rename(from, to)
  if type(from) ~= "string" or from == "" or type(to) ~= "string" or to == "" then
    return false, "无效的文件路径"
  end
  local ok, err = os.rename(from, to)
  if ok then return true end
  return false, "无法重命名文件：" .. tostring(err)
end

-- Probe writability without creating the directory itself.
function M.writable(dir)
  if type(dir) ~= "string" or dir == "" then
    return false, "无效的目录路径"
  end
  tmpSeq = tmpSeq + 1
  local probe = util.join(dir, ".ecm-write-test-" .. tostring(os.time()) .. "-" .. tostring(tmpSeq))
  local file, openErr = io.open(probe, "wb")
  if not file then
    return false, "目录不可写：" .. tostring(openErr or dir)
  end
  file:close()
  os.remove(probe)
  return true
end

local function targetNameOk(target)
  if type(target) ~= "string" or target == "" or #target > 230 then return false end
  if target == "." or target == ".." then return false end
  if target:find("/", 1, true) or target:find("\\", 1, true) then return false end
  if target:find("..", 1, true) then return false end
  for i = 1, #target do
    local b = target:byte(i)
    if b < 32 or b == 127 then return false end
  end
  return true
end

local function parseBackupName(name)
  local _, reason, target =
    name:match("^(%d%d%d%d%d%d%d%dT%d%d%d%d%d%dZ)%-%-(.-)%-%-(.+)$")
  if not reason or not util.trim(reason):match("^[a-z%-]+$") then return nil end
  if not targetNameOk(target) then return nil end
  return { reason = reason, target = target }
end

local function effectiveMainBasename()
  local ok, value = pcall(host.config.get, "mainConfig")
  if ok and type(value) == "string" and util.trim(value) ~= "" then
    return util.basename(util.trim(value))
  end
  return "Caddyfile"
end

-- Main-config and site backups can share a basename (e.g. a main file named
-- foo.caddy and a site foo). Derive the scope from the reason first; the
-- basename fallback is only for older backups with unknown reasons.
local MAIN_REASONS = { global = true, init = true, ["restore-global"] = true }

local function scopeFor(reason, target, mainBase)
  if reason ~= nil then
    if MAIN_REASONS[reason] then return "global" end
    return "site"
  end
  if target == mainBase or target == "Caddyfile" then return "global" end
  return "site"
end

-- Delete oldest backups beyond `keep` (name order == timestamp order) but
-- never the protected name. Two backups created in the same second can have
-- names whose order does not match creation order, and the backup just
-- created must survive for rollback.
local function pruneExcept(keep, protected)
  keep = tonumber(keep)
  if not keep or keep ~= keep or keep < 0 then return 0 end
  keep = math.floor(keep)
  local names = {}
  local entries = listFiles(M.backupsDir)
  for i = 1, #entries do
    local name = entries[i].name
    if util.safeBackupName(name) and parseBackupName(name) then
      names[#names + 1] = name
    end
  end
  table.sort(names)
  local excess = #names - keep
  if excess <= 0 then return 0 end
  local removed = 0
  for i = 1, #names do
    if removed >= excess then break end
    if names[i] ~= protected then
      local ok = os.remove(M.backupsDir .. "/" .. names[i])
      if ok then removed = removed + 1 end
    end
  end
  return removed
end

-- Back up path into backupsDir. Returns the new name, or nil when the source
-- does not exist (nothing to back up). `keep` overrides the config value; when
-- omitted the effective host config is read directly (fs must not require
-- settings, to keep the require graph acyclic).
function M.backup(path, reason, keep)
  if type(reason) ~= "string" or not reason:match("^[a-z%-]+$") then
    return nil, "无效的备份原因"
  end
  local target = util.basename(path)
  -- Main-config basenames can approach the filesystem limit; the timestamp and
  -- reason prefix would overflow the backup name. Site targets are bounded by
  -- the slug (<=134 bytes), so a target this long is the main Caddyfile.
  if #target > 200 then target = "Caddyfile" end
  if not targetNameOk(target) then
    return nil, "文件名包含不支持的字符，无法备份"
  end
  -- Timestamp (16) + two "--" separators (4) + reason must fit in 255 bytes,
  -- otherwise the resulting backup name would fail safeBackupName on read.
  if #target > 230 - #reason then
    return nil, "文件名过长，无法备份"
  end

  local sourceInfo, statErr = M.stat(path)
  if not sourceInfo then
    local message = type(statErr) == "string" and statErr or ""
    if message:lower():find("no such file", 1, true) or message:find("ENOENT", 1, true) then
      return nil
    end
    return nil, "无法读取文件状态：" .. message
  end
  if sourceInfo.type ~= "file" then
    return nil, "不是普通文件，无法备份：" .. tostring(path)
  end
  local content, readErr = M.read(path)
  if content == nil then return nil, readErr end

  local ok, err = M.mkdirp(M.backupsDir)
  if not ok then return nil, err end
  local chmodResult, chmodErr = run("chmod", { "0700", "--", M.backupsDir }, EXEC_TIMEOUT)
  if not chmodResult then return nil, chmodErr end
  if chmodResult.timedOut or chmodResult.exitCode ~= 0 then
    return nil, "无法设置备份目录权限：" .. M.backupsDir
  end

  local baseEpoch = os.time()
  local name
  for offset = 0, 86400 do
    local stamp = os.date("!%Y%m%dT%H%M%SZ", baseEpoch + offset)
    local candidate = stamp .. "--" .. reason .. "--" .. target
    if not M.exists(M.backupsDir .. "/" .. candidate) then
      name = candidate
      break
    end
  end
  if not name then return nil, "无法生成唯一的备份文件名" end

  local written, writeErr = M.writeAtomic(M.backupsDir .. "/" .. name, content, "0600")
  if not written then return nil, writeErr end

  local effectiveKeep = tonumber(keep)
  if not effectiveKeep then
    local configOk, configured = pcall(host.config.get, "backupKeep")
    if configOk then
      effectiveKeep = tonumber(configured)
      -- Mirror settings.load()'s clamp for the raw config fallback path.
      if effectiveKeep then
        if effectiveKeep < 10 then
          effectiveKeep = 10
        elseif effectiveKeep > 1000 then
          effectiveKeep = 1000
        end
      end
    end
  end
  if effectiveKeep then pruneExcept(effectiveKeep, name) end

  return name
end

-- Newest first. scope is "global" for the main Caddyfile (basename compared to
-- settings.mainConfig, passed in by the caller or read from host config).
function M.listBackups(mainBasename)
  local mainBase = effectiveMainBasename()
  if type(mainBasename) == "string" and mainBasename ~= "" then
    mainBase = mainBasename
  end
  local out = util.array({})
  local entries = listFiles(M.backupsDir)
  for i = 1, #entries do
    local entry = entries[i]
    if util.safeBackupName(entry.name) then
      local parsed = parseBackupName(entry.name)
      if parsed then
        out[#out + 1] = {
          name = entry.name,
          size = entry.size,
          mtime = entry.mtime,
          reason = parsed.reason,
          target = parsed.target,
          scope = scopeFor(parsed.reason, parsed.target, mainBase),
        }
      end
    end
  end
  table.sort(out, function(a, b) return a.name > b.name end)
  return out
end

function M.backupInfo(name, mainBasename)
  if type(name) ~= "string" or not util.safeBackupName(name) then
    return nil, "无效的备份文件名"
  end
  local parsed = parseBackupName(name)
  if not parsed then return nil, "无法解析备份文件名" end
  local mainBase = effectiveMainBasename()
  if type(mainBasename) == "string" and mainBasename ~= "" then
    mainBase = mainBasename
  end
  local info = M.stat(M.backupsDir .. "/" .. name)
  if not info or info.type ~= "file" then return nil, "备份文件不存在" end
  return {
    name = name,
    reason = parsed.reason,
    target = parsed.target,
    scope = scopeFor(parsed.reason, parsed.target, mainBase),
    size = info.size,
    mtime = info.mtime,
  }
end

function M.readBackup(name, mainBasename)
  local info, infoErr = M.backupInfo(name, mainBasename)
  if not info then return nil, nil, infoErr end
  local content, readErr = M.read(M.backupsDir .. "/" .. name)
  if content == nil then return nil, nil, readErr end
  return content, info
end

-- Keep the newest `keep` backups (name order == timestamp order).
function M.pruneBackups(keep)
  return pruneExcept(keep, nil)
end

return M
