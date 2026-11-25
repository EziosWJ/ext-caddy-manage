-- util.lua — dependency-free helpers shared by all modules.
-- gopher-lua runs Lua 5.1: no goto/utf8/bit32/debug, and os.date lacks %s/%T/%j.
local M = {}

local function isString(value)
  return type(value) == "string"
end

function M.trim(s)
  if not isString(s) then return "" end
  -- gsub returns (string, count); the parentheses keep only the string.
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

function M.lower(s)
  if not isString(s) then return "" end
  return s:lower()
end

function M.startsWith(s, prefix)
  if not isString(s) or not isString(prefix) then return false end
  if prefix == "" then return true end
  return s:sub(1, #prefix) == prefix
end

function M.endsWith(s, suffix)
  if not isString(s) or not isString(suffix) then return false end
  if suffix == "" then return true end
  if #s < #suffix then return false end
  return s:sub(-#suffix) == suffix
end

function M.contains(list, value)
  if type(list) ~= "table" then return false end
  for i = 1, #list do
    if list[i] == value then return true end
  end
  return false
end

-- host.json.encode serializes an empty table as {} unless the table carries a
-- metatable {__host_array=true}; every list that can be empty must be marked.
function M.array(t)
  if type(t) ~= "table" then return t end
  return setmetatable(t, { __host_array = true })
end

function M.isArray(t)
  if type(t) ~= "table" then return false end
  local mt = getmetatable(t)
  return type(mt) == "table" and mt.__host_array == true
end

-- Split into lines without terminators. Interior empty lines are preserved;
-- one trailing newline does not create a trailing empty element.
function M.splitLines(s)
  local out = M.array({})
  if not isString(s) or s == "" then return out end
  if s:sub(-1) == "\n" then s = s:sub(1, -2) end
  for line in (s .. "\n"):gmatch("(.-)\n") do
    if line:sub(-1) == "\r" then line = line:sub(1, -2) end
    out[#out + 1] = line
  end
  return out
end

function M.nowUTC()
  -- gopher-lua's %Z prints the zone name ("UTC"), never a literal Z, so the
  -- literal is appended outside the format string.
  return os.date("!%Y-%m-%dT%H:%M:%S") .. "Z"
end

function M.nowEpoch()
  return os.time()
end

-- Howard Hinnant's days_from_civil: pure arithmetic, no local timezone use.
local function daysFromCivil(y, m, d)
  if m <= 2 then y = y - 1 end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local mp = m + (m > 2 and -3 or 9)
  local doy = math.floor((153 * mp + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
end

function M.utcEpoch(y, mo, d, h, mi, s)
  y, mo, d = tonumber(y), tonumber(mo), tonumber(d)
  if not y or not mo or not d then return nil end
  h = tonumber(h) or 0
  mi = tonumber(mi) or 0
  s = tonumber(s) or 0
  return daysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s
end

-- Accepts YYYY-MM-DDTHH:MM:SSZ and the same with fractional seconds.
function M.parseUTC(value)
  if not isString(value) then return nil end
  local y, mo, d, h, mi, s =
    value:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)Z$")
  if not y then
    y, mo, d, h, mi, s =
      value:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d+Z$")
  end
  if not y then return nil end
  y, mo, d, h, mi, s = tonumber(y), tonumber(mo), tonumber(d), tonumber(h), tonumber(mi), tonumber(s)
  if mo < 1 or mo > 12 or d < 1 or d > 31 or h > 23 or mi > 59 or s > 60 then
    return nil
  end
  return M.utcEpoch(y, mo, d, h, mi, s)
end

function M.daysUntil(epoch, now)
  local target = tonumber(epoch)
  local base = tonumber(now) or os.time()
  if target == nil then return nil end
  return math.floor((target - base) / 86400)
end

function M.jsonEncode(value)
  local ok, text = pcall(host.json.encode, value)
  if not ok then return nil, tostring(text) end
  return text
end

function M.jsonDecode(text)
  if not isString(text) then return nil, "JSON 文本无效" end
  local ok, value = pcall(host.json.decode, text)
  if not ok then return nil, tostring(value) end
  return value
end

local function basicSlug(value)
  if not isString(value) then return "" end
  local slug = value:lower():gsub("[^a-z0-9]+", "-")
  slug = slug:gsub("^%-+", ""):gsub("%-+$", "")
  return slug
end

local function boundedSlug(slug)
  slug = slug:sub(1, 64):gsub("%-+$", "")
  if slug == "" then
    slug = "site-" .. tostring(os.time())
    slug = slug:sub(1, 64):gsub("%-+$", "")
  end
  return slug
end

-- Derive a unique [a-z0-9-]{1,64} slug from a name, then the first domain,
-- then a timestamp. isTaken may be nil.
function M.slugify(name, domains, isTaken)
  local slug = basicSlug(name)
  if slug == "" and type(domains) == "table" and type(domains[1]) == "string" then
    slug = basicSlug(domains[1])
  end
  if slug == "" then slug = "site-" .. tostring(os.time()) end
  slug = boundedSlug(slug)

  local taken = isTaken
  if type(taken) ~= "function" then
    taken = function() return false end
  end
  if not taken(slug) then return slug end

  for index = 2, 9999 do
    local suffix = "-" .. tostring(index)
    local base = boundedSlug(slug:sub(1, 64 - #suffix))
    local candidate = base .. suffix
    if not taken(candidate) then return candidate end
  end
  -- Practically unreachable; keep the result inside the length limit.
  local fallback = slug:sub(1, 54) .. "-" .. tostring(os.time() % 10000000)
  return boundedSlug(fallback)
end

function M.basename(path)
  if not isString(path) or path == "" then return "" end
  local trimmed = path:gsub("/+$", "")
  if trimmed == "" then return "/" end
  return trimmed:match("([^/]+)$")
end

function M.dirname(path)
  if not isString(path) or path == "" then return "." end
  local trimmed = path:gsub("/+$", "")
  if trimmed == "" then return "/" end
  local dir = trimmed:match("^(.*)/[^/]*$")
  if dir == nil then return "." end
  if dir == "" then return "/" end
  return dir
end

function M.join(...)
  local parts = {}
  for i = 1, select("#", ...) do
    local part = select(i, ...)
    if isString(part) and part ~= "" then
      parts[#parts + 1] = part
    end
  end
  local joined = table.concat(parts, "/")
  return (joined:gsub("//+", "/"))
end

function M.isAbsolute(path)
  return isString(path) and path:sub(1, 1) == "/"
end

function M.safeSlug(slug)
  if not isString(slug) or slug == "" or #slug > 128 then return false end
  if slug == "." or slug == ".." then return false end
  if not slug:match("^[A-Za-z0-9._%-]+$") then return false end
  if slug:find("..", 1, true) then return false end
  return true
end

function M.safeBackupName(name)
  if not isString(name) or name == "" or #name > 255 then return false end
  -- Backup names are path components, never paths. Keep the original file
  -- basename intact (spaces and non-ASCII are allowed); only reject characters
  -- that would escape the backup directory or break the find/parse format.
  if name == "." or name == ".." then return false end
  if name:find("/", 1, true) or name:find("\\", 1, true) then return false end
  if name:find("..", 1, true) then return false end
  for i = 1, #name do
    local b = name:byte(i)
    if b < 32 or b == 127 then return false end
  end
  return true
end

-- Count UTF-8 code points without requiring the utf8 library.
function M.utf8Length(s)
  if not isString(s) then return 0 end
  local count = 0
  for i = 1, #s do
    local b = s:byte(i)
    if b < 0x80 or b >= 0xC0 then count = count + 1 end
  end
  return count
end

function M.round(n)
  n = tonumber(n)
  if n == nil or n ~= n then return 0 end
  return math.floor(n + 0.5)
end

function M.clamp(n, minimum, maximum)
  n = tonumber(n)
  if n == nil or n ~= n then return minimum end
  if n < minimum then return minimum end
  if n > maximum then return maximum end
  return n
end

return M
