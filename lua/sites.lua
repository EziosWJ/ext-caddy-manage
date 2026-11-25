-- Site model validation and Caddyfile generation.
local util = require("util")
local fs = require("fs")
local settings = require("settings")
local store = require("store")

local M = {}

M.MAX_DOMAINS = 20
M.MAX_UPSTREAMS = 20
M.MAX_AUTH = 20
M.MAX_HEADERS = 20
M.MAX_IP = 100
M.MAX_SNIPPET = 48 * 1024
M.MAX_MODEL = 64 * 1024

M.LB_POLICIES = { "round_robin", "least_conn", "random", "ip_hash", "uri_hash", "first" }

local LB_SET = {}
for _, p in ipairs(M.LB_POLICIES) do LB_SET[p] = true end

local DOMAIN_LABEL_PATTERN = "^[a-z0-9][a-z0-9-]*[a-z0-9]$"
local IPV4_PATTERN = "^%d+%.%d+%.%d+%.%d+$"
local USER_PATTERN = "^[A-Za-z0-9._-]+$"
local HASH_PATTERN = "^%$2[abxy]%$%d%d%$[%w./]+$"
local HEADER_NAME_PATTERN = "^[A-Za-z0-9!#$%%&'*+.^_`|~-]+$"
local HOST_HEADER_PATTERN = "^[A-Za-z0-9._:%-]+$"
local TOKEN_SAFE = "^[A-Za-z0-9_./:@%%+~=,-]+$"
local HEADER_COMMENT = "# 由 ext-caddy-manage 生成；可在面板「配置文件」中编辑。"

local function bad(field, message)
  return { code = "invalid_model", message = message, details = { field = field }, status = 400 }
end

local function sizeErr(field, message, extra)
  local details = { field = field }
  if extra then for k, v in pairs(extra) do details[k] = v end end
  return { code = "size_limit", message = message, details = details, status = 400 }
end

local function isListT(t)
  if type(t) ~= "table" then return false, 0 end
  local n = 0
  for k in pairs(t) do
    if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then return false, 0 end
    if k > n then n = k end
  end
  for i = 1, n do
    if t[i] == nil then return false, 0 end
  end
  return true, n
end

-- A JSON object must not be an array: reject tables with numeric keys so an
-- array cannot masquerade as a static/proxy/security section.
local function isObjectTable(t)
  if type(t) ~= "table" or util.isArray(t) then return false end
  for key in pairs(t) do
    if type(key) ~= "string" then return false end
  end
  return true
end

local function hasNul(s)
  return type(s) == "string" and s:find("\0", 1, true) ~= nil
end

local function hasCrLfNul(s)
  if type(s) ~= "string" then return true end
  return s:find("\r", 1, true) ~= nil or s:find("\n", 1, true) ~= nil or s:find("\0", 1, true) ~= nil
end

local function hasControl(s)
  if type(s) ~= "string" then return true end
  for i = 1, #s do
    local b = s:byte(i)
    if b < 32 or b == 127 then return true end
  end
  return false
end

local function integerOf(v)
  if type(v) == "number" and v % 1 == 0 then return v end
  if type(v) == "string" and v:match("^%-?%d+$") then return tonumber(v) end
  return nil
end

local function copyDomains(list)
  local out = util.array({})
  if type(list) == "table" then
    for i = 1, #list do
      local d = list[i]
      if type(d) == "string" and d ~= "" then out[#out + 1] = d end
    end
  end
  return out
end

local function defaultSecurity()
  return {
    basicAuth = util.array({}),
    ipMode = "off",
    ipList = util.array({}),
    headers = util.array({}),
    hsts = false,
    encode = true,
  }
end

local function validDuration(s)
  if type(s) ~= "string" then return false end
  local num = s:match("^(%d+)")
  if not num then return false end
  local unit = s:sub(#num + 1)
  if unit ~= "ms" and unit ~= "s" and unit ~= "m" and unit ~= "h" then return false end
  local n = tonumber(num)
  if not n then return false end
  local sec
  if unit == "ms" then sec = n / 1000
  elseif unit == "s" then sec = n
  elseif unit == "m" then sec = n * 60
  else sec = n * 3600 end
  return sec > 0 and sec <= 86400
end

-- Lua patterns lack {n,m}; validate labels manually (1-63 chars, alnum ends).
local function validDomain(d)
  if type(d) ~= "string" or d == "" or #d > 253 then return false end
  local pos = 1
  while true do
    local dot = d:find(".", pos, true)
    local label = dot and d:sub(pos, dot - 1) or d:sub(pos)
    if label == "" or #label > 63 then return false end
    if #label == 1 then
      if not label:match("^[a-z0-9]$") then return false end
    elseif not label:match(DOMAIN_LABEL_PATTERN) then
      return false
    end
    if not dot then break end
    pos = dot + 1
  end
  return true
end

local validIPv6

local function validUpstream(s)
  if type(s) ~= "string" or s == "" then return false end
  if s:find("%s") then return false end
  local rest = s
  if s:sub(1, 7) == "http://" then
    rest = s:sub(8)
  elseif s:sub(1, 8) == "https://" then
    rest = s:sub(9)
  elseif s:find("://", 1, true) then
    return false
  end
  if rest == "" then return false end
  if rest:find("/", 1, true) or rest:find("?", 1, true) or rest:find("#", 1, true)
    or rest:find("@", 1, true) or rest:find("\\", 1, true) then
    return false
  end
  local port
  if rest:sub(1, 1) == "[" then
    local host, p = rest:match("^%[([0-9A-Fa-f:.]+)%]:(%d+)$")
    if not host or not p or not validIPv6(host) then return false end
    port = p
  else
    local host, p = rest:match("^([A-Za-z0-9._-]+):(%d+)$")
    if not host or not p then return false end
    port = p
  end
  local pn = tonumber(port)
  if not pn or pn < 1 or pn > 65535 then return false end
  return true
end

local function validIPv4(s)
  if type(s) ~= "string" then return false end
  local a, b, c, d = s:match("^(%d+)%.(%d+)%.(%d+)%.(%d+)$")
  if not a then return false end
  local parts = { a, b, c, d }
  for i = 1, 4 do
    local n = tonumber(parts[i])
    if not n or n > 255 then return false end
  end
  return true
end

local function ipv6PartGroups(part, allowV4Last)
  if part == "" then return 0 end
  if part:sub(1, 1) == ":" or part:sub(-1) == ":" then return nil end
  local groups = 0
  local pos = 1
  while true do
    local colon = part:find(":", pos, true)
    local segment = colon and part:sub(pos, colon - 1) or part:sub(pos)
    if segment == "" then return nil end
    if segment:find(".", 1, true) then
      if not allowV4Last or colon ~= nil or not validIPv4(segment) then return nil end
      groups = groups + 2
    else
      if #segment > 4 or not segment:match("^[0-9A-Fa-f]+$") then return nil end
      groups = groups + 1
    end
    if not colon then break end
    pos = colon + 1
  end
  return groups
end

-- Full-enough IPv6 literal validation: group count, hex width, one "::",
-- and an optional trailing IPv4. Caddy does not reject bad upstream dial
-- strings at adapt time, so this check must catch them before writing.
validIPv6 = function(s)
  if type(s) ~= "string" or s == "" then return false end
  if s:find("%", 1, true) then return false end
  if not s:match("^[0-9A-Fa-f:.]+$") then return false end
  local _, doubles = s:gsub("::", "")
  if doubles > 1 then return false end
  if doubles == 0 then
    if not s:find(":", 1, true) then return false end
    local groups = ipv6PartGroups(s, true)
    return groups == 8
  end
  local left, right = s:match("^(.-)::(.*)$")
  if not left then return false end
  local leftGroups = ipv6PartGroups(left, false)
  local rightGroups = ipv6PartGroups(right, true)
  if leftGroups == nil or rightGroups == nil then return false end
  return leftGroups + rightGroups < 8
end

local function validIPEntry(s)
  if type(s) ~= "string" or s == "" then return false end
  local addr, prefix = s:match("^([^/]+)/(%d+)$")
  if addr then
    local p = tonumber(prefix)
    if validIPv4(addr) then return p >= 0 and p <= 32 end
    if validIPv6(addr) then return p >= 0 and p <= 128 end
    return false
  end
  if s:find("/", 1, true) then return false end
  return validIPv4(s) or validIPv6(s)
end

local function quoteAlways(s)
  s = tostring(s or "")
  s = s:gsub("\\", "\\\\")
  s = s:gsub('"', '\\"')
  return '"' .. s .. '"'
end

local function quoteToken(s)
  s = tostring(s or "")
  if s:match(TOKEN_SAFE) then return s end
  return quoteAlways(s)
end

function M.parseModelRow(row)
  if type(row) ~= "table" then
    return nil, { code = "invalid_model", message = "站点模型不存在", status = 400 }
  end
  local raw = row.model
  if type(raw) == "table" then return raw end
  if type(raw) ~= "string" or raw == "" then
    return nil, { code = "invalid_model", message = "站点模型为空", details = { slug = row.slug }, status = 400 }
  end
  local ok, model = pcall(util.jsonDecode, raw)
  if not ok or type(model) ~= "table" then
    return nil, { code = "invalid_model", message = "站点模型解析失败", details = { slug = row.slug }, status = 400 }
  end
  return model
end

function M.mainPath()
  return settings.load().mainConfig
end

function M.snippetPath(slug, enabled)
  local s = settings.load()
  if enabled == false then
    return s.disabledDir .. "/" .. slug .. ".caddy"
  end
  return s.snippetDir .. "/" .. slug .. ".caddy"
end

-- Load all snippets from disk and merge DB metadata. Filesystem wins.
function M.loadAll()
  local s = settings.load()
  local warnings = util.array({})
  local function warn(msg) warnings[#warnings + 1] = msg end

  local function scan(dir)
    local ok, files = pcall(fs.list, dir)
    if not ok or type(files) ~= "table" then return {} end
    return files
  end

  local function slugFromName(name)
    if type(name) ~= "string" or #name < 6 then return nil end
    if name:sub(-6) ~= ".caddy" then return nil end
    return name:sub(1, #name - 6)
  end

  local files = {}
  for _, f in ipairs(scan(s.snippetDir)) do
    local slug = slugFromName(f.name)
    if slug then
      if util.safeSlug(slug) then
        files[slug] = {
          slug = slug,
          enabled = true,
          path = s.snippetDir .. "/" .. f.name,
          size = tonumber(f.size) or 0,
          mtime = tonumber(f.mtime) or 0,
          conflict = false,
        }
      else
        warn("忽略非法名称的片段文件：" .. tostring(f.name))
      end
    end
  end
  for _, f in ipairs(scan(s.disabledDir)) do
    local slug = slugFromName(f.name)
    if slug then
      if util.safeSlug(slug) then
        local existing = files[slug]
        if existing then
          existing.conflict = true
        else
          files[slug] = {
            slug = slug,
            enabled = false,
            path = s.disabledDir .. "/" .. f.name,
            size = tonumber(f.size) or 0,
            mtime = tonumber(f.mtime) or 0,
            conflict = false,
          }
        end
      else
        warn("忽略非法名称的停用片段文件：" .. tostring(f.name))
      end
    end
  end

  local rowBySlug = {}
  local okRows, dbRows = pcall(store.listSites)
  if okRows and type(dbRows) == "table" then
    for _, row in ipairs(dbRows) do
      if type(row) == "table" and type(row.slug) == "string" then
        if util.safeSlug(row.slug) then
          rowBySlug[row.slug] = row
        else
          warn("忽略非法站点元数据：" .. row.slug)
        end
      end
    end
  else
    warn("读取站点元数据失败")
  end

  local items = util.array({})
  local bySlug = {}
  local function addItem(item)
    items[#items + 1] = item
    bySlug[item.slug] = item
  end

  local function applyRowMeta(item, row)
    item.name = type(row.name) == "string" and row.name or item.slug
    item.group = type(row.group_name) == "string" and row.group_name or ""
    item.note = type(row.note) == "string" and row.note or ""
    item.type = type(row.type) == "string" and row.type or "custom"
    item.createdAt = type(row.created_at) == "string" and row.created_at or ""
    item.updatedAt = type(row.updated_at) == "string" and row.updated_at or ""
    item.lastContent = type(row.last_content) == "string" and row.last_content or nil
    local model = M.parseModelRow(row)
    if model then
      item.model = model
      item.domains = copyDomains(model.domains)
    else
      item.model = nil
      item.modelError = true
    end
  end

  for slug, f in pairs(files) do
    local item = {
      slug = slug,
      domains = util.array({}),
      enabled = f.enabled,
      custom = false,
      orphan = false,
      conflict = f.conflict,
      path = f.path,
      size = f.size,
      mtime = f.mtime,
      createdAt = "",
      updatedAt = "",
    }
    local row = rowBySlug[slug]
    if row then
      applyRowMeta(item, row)
    else
      item.custom = true
      item.name = slug
      item.group = ""
      item.note = ""
      item.type = "custom"
      item.model = nil
      item.lastContent = nil
    end
    addItem(item)
  end

  for slug, row in pairs(rowBySlug) do
    if not files[slug] then
      local item = {
        slug = slug,
        domains = util.array({}),
        enabled = false,
        custom = false,
        orphan = true,
        conflict = false,
        path = nil,
        size = 0,
        mtime = 0,
        createdAt = "",
        updatedAt = "",
      }
      applyRowMeta(item, row)
      addItem(item)
    end
  end

  table.sort(items, function(a, b)
    if a.enabled ~= b.enabled then return a.enabled end
    local an = util.lower(a.name or a.slug or "")
    local bn = util.lower(b.name or b.slug or "")
    if an ~= bn then return an < bn end
    return (a.slug or "") < (b.slug or "")
  end)

  local domains = {}
  for _, item in ipairs(items) do
    if not item.custom and not item.orphan then
      for i = 1, #item.domains do
        local d = util.lower(item.domains[i])
        if d ~= "" and domains[d] == nil then domains[d] = item.slug end
      end
    end
  end

  return { items = items, bySlug = bySlug, domains = domains, warnings = warnings }
end

-- Detail item: adds raw content and drift information.
function M.get(slug)
  if type(slug) ~= "string" or not util.safeSlug(slug) then return nil end
  local all = M.loadAll()
  local item = all.bySlug[slug]
  if not item then return nil end
  local raw = nil
  if item.path then
    local info, exists, statErr = fs.statChecked(item.path)
    if statErr then
      return nil, {
        code = "internal",
        message = "读取站点片段状态失败：" .. tostring(statErr),
        details = { slug = slug, path = item.path },
        status = 500,
      }
    end
    if not exists then
      if item.custom then
        return nil, {
          code = "not_found",
          message = "站点片段不存在，可能已被外部删除",
          details = { slug = slug, path = item.path },
          status = 404,
        }
      end
      item.orphan = true
      item.enabled = false
      item.path = nil
      item.size = 0
      item.mtime = 0
    elseif info.type ~= "file" then
      return nil, {
        code = "internal",
        message = "站点片段路径不是普通文件",
        details = { slug = slug, path = item.path },
        status = 500,
      }
    else
      local content, readErr = fs.read(item.path)
      if content == nil then
        return nil, {
          code = "internal",
          message = "读取站点片段失败：" .. tostring(readErr),
          details = { slug = slug, path = item.path },
          status = 500,
        }
      end
      raw = content
    end
  end
  item.raw = raw
  if item.orphan or item.custom then
    item.drift = false
  else
    item.drift = raw ~= item.lastContent
  end
  return item
end

local function normalizeSecurity(sec)
  local out = defaultSecurity()
  if type(sec) ~= "table" then return out, nil end

  if sec.basicAuth ~= nil then
    local okList, n = isListT(sec.basicAuth)
    if not okList then return nil, bad("security.basicAuth", "Basic Auth 必须是数组") end
    if n > M.MAX_AUTH then return nil, bad("security.basicAuth", "Basic Auth 用户不能超过 " .. M.MAX_AUTH .. " 个") end
    local auth = util.array({})
    local users = {}
    for i = 1, n do
      local entry = sec.basicAuth[i]
      if type(entry) ~= "table" then return nil, bad("security.basicAuth", "Basic Auth 条目必须是对象") end
      local user, hash = entry.user, entry.hash
      if type(user) ~= "string" or #user < 1 or #user > 64 or not user:match(USER_PATTERN) then
        return nil, bad("security.basicAuth", "Basic Auth 用户名只能包含字母、数字、点、下划线和连字符（1-64）")
      end
      if type(hash) ~= "string" or not hash:match(HASH_PATTERN) then
        return nil, bad("security.basicAuth", "Basic Auth 密码哈希必须是 bcrypt（$2a/$2b/$2x/$2y）")
      end
      if users[user] then return nil, bad("security.basicAuth", "Basic Auth 用户名重复：" .. user) end
      users[user] = true
      auth[#auth + 1] = { user = user, hash = hash }
    end
    out.basicAuth = auth
  end

  if sec.ipMode ~= nil then
    if type(sec.ipMode) ~= "string" or (sec.ipMode ~= "off" and sec.ipMode ~= "allow" and sec.ipMode ~= "deny") then
      return nil, bad("security.ipMode", "IP 模式必须是 off、allow 或 deny")
    end
    out.ipMode = sec.ipMode
  end

  if sec.ipList ~= nil then
    local okList, n = isListT(sec.ipList)
    if not okList then return nil, bad("security.ipList", "IP 列表必须是数组") end
    if n > M.MAX_IP then return nil, bad("security.ipList", "IP 列表不能超过 " .. M.MAX_IP .. " 项") end
    local ips = util.array({})
    for i = 1, n do
      local entry = sec.ipList[i]
      if type(entry) ~= "string" or not validIPEntry(entry) then
        return nil, bad("security.ipList", "无效的 IP 或网段：" .. tostring(entry))
      end
      ips[#ips + 1] = entry
    end
    out.ipList = ips
  end
  if out.ipMode ~= "off" and #out.ipList == 0 then
    return nil, bad("security.ipList", "启用 IP 过滤时至少需要一个 IP 或网段")
  end

  if sec.headers ~= nil then
    local okList, n = isListT(sec.headers)
    if not okList then return nil, bad("security.headers", "响应头必须是数组") end
    if n > M.MAX_HEADERS then return nil, bad("security.headers", "响应头不能超过 " .. M.MAX_HEADERS .. " 个") end
    local headers = util.array({})
    local seen = {}
    for i = 1, n do
      local entry = sec.headers[i]
      if type(entry) ~= "table" then return nil, bad("security.headers", "响应头条目必须是对象") end
      local name, value = entry.name, entry.value
      if type(name) ~= "string" or #name < 1 or #name > 128 or not name:match(HEADER_NAME_PATTERN) then
        return nil, bad("security.headers", "响应头名称无效：" .. tostring(name))
      end
      if type(value) ~= "string" or #value > 4096 or hasCrLfNul(value) then
        return nil, bad("security.headers", "响应头值无效或超过 4096 字节：" .. name)
      end
      -- Caddy's lexer treats a token that is exactly a brace as a block
      -- delimiter even when it came from a quoted string.
      local trimmedValue = util.trim(value)
      if trimmedValue == "{" or trimmedValue == "}" then
        return nil, bad("security.headers", "响应头值不能只有花括号：" .. name)
      end
      local lname = util.lower(name)
      if seen[lname] then return nil, bad("security.headers", "响应头名称重复：" .. name) end
      seen[lname] = true
      headers[#headers + 1] = { name = name, value = value }
    end
    out.headers = headers
  end

  if sec.hsts ~= nil then
    if type(sec.hsts) ~= "boolean" then return nil, bad("security.hsts", "HSTS 开关必须是布尔值") end
    out.hsts = sec.hsts
  end
  if sec.encode ~= nil then
    if type(sec.encode) ~= "boolean" then return nil, bad("security.encode", "压缩开关必须是布尔值") end
    out.encode = sec.encode
  end
  return out, nil
end

-- Validate and normalize a site model.
function M.validate(model, opts)
  opts = opts or {}
  if type(model) ~= "table" then return nil, bad("model", "站点模型必须是对象") end

  local encoded, encErr = util.jsonEncode(model)
  if not encoded then
    return nil, bad("model", "站点模型无法序列化：" .. tostring(encErr))
  end
  if #encoded > M.MAX_MODEL then
    return nil, sizeErr("model", "站点模型超过 64 KiB 限制", { limit = M.MAX_MODEL, size = #encoded })
  end

  if type(model.name) ~= "string" then return nil, bad("name", "站点名称不能为空") end
  local name = util.trim(model.name)
  if #name < 1 or util.utf8Length(name) > 80 then
    return nil, bad("name", "站点名称长度必须为 1-80 个字符")
  end
  if hasNul(name) then return nil, bad("name", "站点名称不能包含 NUL 字符") end

  local typ = model.type
  if type(typ) ~= "string" then
    if opts.existing and type(opts.existing.type) == "string" then
      typ = opts.existing.type
    else
      return nil, bad("type", "站点类型无效")
    end
  end
  if typ ~= "static" and typ ~= "proxy" and typ ~= "redirect" then
    return nil, bad("type", "站点类型必须是 static、proxy 或 redirect")
  end
  if opts.existing and type(opts.existing.type) == "string" and opts.existing.type ~= typ then
    return nil, bad("type", "站点类型创建后不可修改")
  end

  local https = true
  if model.https ~= nil then
    if type(model.https) ~= "boolean" then return nil, bad("https", "HTTPS 开关必须是布尔值") end
    https = model.https
  end

  local group = "默认"
  if model.group ~= nil then
    if type(model.group) ~= "string" then return nil, bad("group", "分组必须是字符串") end
    local g = util.trim(model.group)
    if util.utf8Length(g) > 40 then return nil, bad("group", "分组长度不能超过 40 个字符") end
    if g ~= "" then group = g end
  end

  local note = ""
  if model.note ~= nil then
    if type(model.note) ~= "string" then return nil, bad("note", "备注必须是字符串") end
    if util.utf8Length(model.note) > 2000 then return nil, bad("note", "备注不能超过 2000 个字符") end
    if hasNul(model.note) then return nil, bad("note", "备注不能包含 NUL 字符") end
    note = model.note
  end

  local okDomains, domainCount = isListT(model.domains)
  if not okDomains then return nil, bad("domains", "域名必须是数组") end
  if domainCount < 1 then return nil, bad("domains", "至少需要一个域名") end
  if domainCount > M.MAX_DOMAINS then
    return nil, bad("domains", "域名数量不能超过 " .. M.MAX_DOMAINS .. " 个")
  end
  local domains = util.array({})
  local seenDomain = {}
  for i = 1, domainCount do
    local raw = model.domains[i]
    if type(raw) ~= "string" then return nil, bad("domains", "域名必须是字符串") end
    local d = util.lower(raw)
    if #d > 253 then return nil, bad("domains", "域名长度不能超过 253 个字符") end
    if util.trim(d) ~= d or d:find("%s") then
      return nil, bad("domains", "域名不能包含空白字符")
    end
    if d:match(IPV4_PATTERN) then
      return nil, bad("domains", "不支持使用 IP 地址作为域名：" .. d)
    end
    if not validDomain(d) then
      return nil, bad("domains", "域名格式无效：" .. d)
    end
    if not seenDomain[d] then
      seenDomain[d] = true
      domains[#domains + 1] = d
    end
  end
  if #domains < 1 then return nil, bad("domains", "至少需要一个有效域名") end

  if opts.sites and type(opts.sites.domains) == "table" then
    for i = 1, #domains do
      local owner = opts.sites.domains[domains[i]]
      if type(owner) == "string" and (not opts.slug or owner ~= opts.slug) then
        return nil, {
          code = "conflict",
          message = "域名 " .. domains[i] .. " 已被站点 " .. owner .. " 使用",
          details = { field = "domains", domain = domains[i], slug = owner },
          status = 409,
        }
      end
    end
  end

  local static = nil
  if typ == "static" then
    local st = model.static
    if st == nil then st = {} end
    if type(st) ~= "table" or not isObjectTable(st) then
      return nil, bad("static", "静态站配置必须是对象")
    end
    local root = ""
    if st.root ~= nil then
      if type(st.root) ~= "string" then return nil, bad("static.root", "根目录必须是字符串") end
      root = st.root
    end
    local browse = false
    if st.browse ~= nil then
      if type(st.browse) ~= "boolean" then return nil, bad("static.browse", "目录浏览开关必须是布尔值") end
      browse = st.browse
    end
    local spa = false
    if st.spa ~= nil then
      if type(st.spa) ~= "boolean" then return nil, bad("static.spa", "SPA 开关必须是布尔值") end
      spa = st.spa
    end
    if util.trim(root) == "" then
      if not opts.creating then return nil, bad("static.root", "根目录不能为空") end
      root = ""
    else
      if #root > 4096 then return nil, bad("static.root", "根目录不能超过 4096 个字符") end
      if not util.isAbsolute(root) then return nil, bad("static.root", "根目录必须是绝对路径") end
      if hasCrLfNul(root) then return nil, bad("static.root", "根目录不能包含换行或 NUL 字符") end
    end
    static = { root = root, browse = browse, spa = spa }
  end

  local proxy = nil
  if typ == "proxy" then
    local p = model.proxy
    if type(p) ~= "table" or not isObjectTable(p) then
      return nil, bad("proxy", "反向代理配置必须是对象")
    end

    local okUps, upCount = isListT(p.upstreams)
    if not okUps then return nil, bad("proxy.upstreams", "上游必须是数组") end
    if upCount < 1 then return nil, bad("proxy.upstreams", "至少需要一个上游") end
    if upCount > M.MAX_UPSTREAMS then
      return nil, bad("proxy.upstreams", "上游数量不能超过 " .. M.MAX_UPSTREAMS .. " 个")
    end
    local upstreams = util.array({})
    local sawBare, sawHttp, sawHttps = false, false, false
    for i = 1, upCount do
      local raw = p.upstreams[i]
      if type(raw) ~= "string" then return nil, bad("proxy.upstreams", "上游必须是字符串") end
      local u = util.trim(raw)
      if not validUpstream(u) then
        return nil, bad("proxy.upstreams", "上游格式无效（仅支持 host:port、[v6]:port 或 http(s)://host:port）：" .. raw)
      end
      if u:sub(1, 8) == "https://" then
        sawHttps = true
      elseif u:sub(1, 7) == "http://" then
        sawHttp = true
      else
        sawBare = true
      end
      upstreams[#upstreams + 1] = u
    end
    -- Caddy's reverse_proxy accepts either all scheme-less upstreams or one
    -- explicit scheme for all of them. Mixing forms is order-sensitive and can
    -- change TLS behavior, so reject it instead of guessing.
    if (sawBare and (sawHttp or sawHttps)) or (sawHttp and sawHttps) then
      return nil, bad("proxy.upstreams",
        "同一反向代理的上游必须全部不带 scheme，或全部使用相同的 http:// / https://")
    end

    local lbPolicy = "round_robin"
    if p.lbPolicy ~= nil then
      if type(p.lbPolicy) ~= "string" or not LB_SET[p.lbPolicy] then
        return nil, bad("proxy.lbPolicy", "负载均衡策略无效")
      end
      lbPolicy = p.lbPolicy
    end

    local h = p.health
    if h == nil then h = {} end
    if type(h) ~= "table" or not isObjectTable(h) then
      return nil, bad("proxy.health", "健康检查配置必须是对象")
    end
    local healthEnabled = false
    if h.enabled ~= nil then
      if type(h.enabled) ~= "boolean" then return nil, bad("proxy.health.enabled", "健康检查开关必须是布尔值") end
      healthEnabled = h.enabled
    end
    local healthUri = "/health"
    if h.uri ~= nil then
      if type(h.uri) ~= "string" then return nil, bad("proxy.health.uri", "健康检查路径必须是字符串") end
      healthUri = h.uri
    end
    if #healthUri > 1024 then return nil, bad("proxy.health.uri", "健康检查路径不能超过 1024 个字符") end
    if healthUri:sub(1, 1) ~= "/" or healthUri:find("%s") or hasControl(healthUri)
      or healthUri:find("{", 1, true) or healthUri:find("}", 1, true) then
      return nil, bad("proxy.health.uri", "健康检查路径必须以 / 开头且不能包含空白或花括号")
    end
    local healthInterval = "10s"
    if h.interval ~= nil then
      if not validDuration(h.interval) then return nil, bad("proxy.health.interval", "健康检查间隔无效（须大于 0 且不超过 86400s）") end
      healthInterval = h.interval
    end
    local healthTimeout = "3s"
    if h.timeout ~= nil then
      if not validDuration(h.timeout) then return nil, bad("proxy.health.timeout", "健康检查超时无效（须大于 0 且不超过 86400s）") end
      healthTimeout = h.timeout
    end
    local healthStatus = 200
    if h.status ~= nil then
      local n = integerOf(h.status)
      if not n or n < 100 or n > 599 then
        return nil, bad("proxy.health.status", "健康检查状态码必须是 100-599 的整数")
      end
      healthStatus = n
    end

    local skipVerify = false
    if p.skipVerify ~= nil then
      if type(p.skipVerify) ~= "boolean" then return nil, bad("proxy.skipVerify", "跳过证书校验开关必须是布尔值") end
      skipVerify = p.skipVerify
    end
    if skipVerify and not sawHttps then
      return nil, bad("proxy.skipVerify", "跳过证书校验仅适用于 https:// 上游")
    end

    local hostHeader = ""
    if p.hostHeader ~= nil then
      if type(p.hostHeader) ~= "string" then return nil, bad("proxy.hostHeader", "Host 头必须是字符串") end
      if #p.hostHeader > 255 then return nil, bad("proxy.hostHeader", "Host 头不能超过 255 个字符") end
      if p.hostHeader ~= "" and not p.hostHeader:match(HOST_HEADER_PATTERN) then
        return nil, bad("proxy.hostHeader", "Host 头包含非法字符")
      end
      hostHeader = p.hostHeader
    end

    local dialTimeout = "5s"
    if p.dialTimeout ~= nil then
      if not validDuration(p.dialTimeout) then return nil, bad("proxy.dialTimeout", "连接超时无效（须大于 0 且不超过 86400s）") end
      dialTimeout = p.dialTimeout
    end
    local responseHeaderTimeout = "30s"
    if p.responseHeaderTimeout ~= nil then
      if not validDuration(p.responseHeaderTimeout) then
        return nil, bad("proxy.responseHeaderTimeout", "响应头超时无效（须大于 0 且不超过 86400s）")
      end
      responseHeaderTimeout = p.responseHeaderTimeout
    end

    proxy = {
      upstreams = upstreams,
      lbPolicy = lbPolicy,
      health = {
        enabled = healthEnabled,
        uri = healthUri,
        interval = healthInterval,
        timeout = healthTimeout,
        status = healthStatus,
      },
      skipVerify = skipVerify,
      hostHeader = hostHeader,
      dialTimeout = dialTimeout,
      responseHeaderTimeout = responseHeaderTimeout,
    }
  end

  local redirect = nil
  if typ == "redirect" then
    local r = model.redirect
    if type(r) ~= "table" or not isObjectTable(r) then
      return nil, bad("redirect", "重定向配置必须是对象")
    end
    local target = r.target
    if type(target) ~= "string" then return nil, bad("redirect.target", "重定向目标必须是字符串") end
    if #target < 1 or #target > 2048 then
      return nil, bad("redirect.target", "重定向目标长度必须为 1-2048 个字符")
    end
    if target:find("%s") or hasControl(target) or hasNul(target) then
      return nil, bad("redirect.target", "重定向目标不能包含空白、控制字符或 NUL")
    end
    local probe = target:gsub("{uri}", "URI")
    if not probe:match("^https?://[^%s{}]+$") then
      return nil, bad("redirect.target", "重定向目标必须是绝对 http(s) URL，仅支持 {uri} 占位符")
    end
    local code = 301
    if r.code ~= nil then
      local n = integerOf(r.code)
      if not n or (n ~= 301 and n ~= 302 and n ~= 307 and n ~= 308) then
        return nil, bad("redirect.code", "重定向状态码必须是 301、302、307 或 308")
      end
      code = n
    end
    redirect = { target = target, code = code }
  end

  local security = defaultSecurity()
  if typ ~= "redirect" then
    if model.security ~= nil
      and (type(model.security) ~= "table" or not isObjectTable(model.security)) then
      return nil, bad("security", "安全配置必须是对象")
    end
    local normalized, secErr = normalizeSecurity(model.security)
    if not normalized then return nil, secErr end
    security = normalized
  end

  local out = {
    name = name,
    type = typ,
    domains = domains,
    https = https,
    group = group,
    note = note,
    security = security,
  }
  if static then out.static = static end
  if proxy then out.proxy = proxy end
  if redirect then out.redirect = redirect end
  return out
end

local function genError(message, field)
  return nil, { code = "invalid_model", message = message, details = { field = field or "model" }, status = 400 }
end

local function appendSecurity(lines, security)
  if type(security) ~= "table" then return end
  local auth = security.basicAuth
  if type(auth) == "table" and #auth > 0 then
    lines[#lines + 1] = "\tbasic_auth {"
    for i = 1, #auth do
      lines[#lines + 1] = "\t\t" .. auth[i].user .. " " .. auth[i].hash
    end
    lines[#lines + 1] = "\t}"
  end

  local ips = security.ipList
  if type(ips) == "table" and security.ipMode and security.ipMode ~= "off" and #ips > 0 then
    local joined = table.concat(ips, " ")
    if security.ipMode == "allow" then
      lines[#lines + 1] = "\t@denied not remote_ip " .. joined
    else
      lines[#lines + 1] = "\t@denied remote_ip " .. joined
    end
    lines[#lines + 1] = "\trespond @denied 403"
  end

  local headers = security.headers
  local headerCount = 0
  if type(headers) == "table" then headerCount = #headers end
  if security.hsts or headerCount > 0 then
    lines[#lines + 1] = "\theader {"
    local sawHsts = false
    if security.hsts then
      lines[#lines + 1] = '\t\tStrict-Transport-Security "max-age=31536000; includeSubDomains"'
      sawHsts = true
    end
    if headerCount > 0 then
      for i = 1, headerCount do
        local h = headers[i]
        if not (sawHsts and util.lower(h.name) == "strict-transport-security") then
          -- Quote the name: a leading # would become a comment and a leading
          -- backtick would be re-lexed as a quoted token.
          lines[#lines + 1] = "\t\t" .. quoteAlways(h.name) .. " " .. quoteAlways(h.value)
        end
      end
    end
    lines[#lines + 1] = "\t}"
  end
end

-- Render the snippet for a validated site model.
function M.generate(model)
  if type(model) ~= "table" then return genError("站点模型无效") end
  local typ = model.type
  local domains = model.domains
  if type(domains) ~= "table" or #domains < 1 then return genError("域名不能为空", "domains") end

  local addresses = util.array({})
  local useHttps = model.https ~= false
  for i = 1, #domains do
    local d = domains[i]
    if type(d) ~= "string" or d == "" then return genError("域名无效", "domains") end
    if useHttps then
      addresses[#addresses + 1] = d
    else
      addresses[#addresses + 1] = "http://" .. d
    end
  end

  local lines = {}
  lines[#lines + 1] = HEADER_COMMENT
  lines[#lines + 1] = table.concat(addresses, ", ") .. " {"

  local security = model.security or defaultSecurity()

  if typ == "static" then
    if security.encode then lines[#lines + 1] = "\tencode zstd gzip" end
    lines[#lines + 1] = "\tlog"
    local st = model.static or {}
    local root = st.root
    if type(root) ~= "string" or root == "" then return genError("根目录不能为空", "static.root") end
    if hasCrLfNul(root) then return genError("根目录包含非法字符", "static.root") end
    lines[#lines + 1] = "\troot * " .. quoteAlways(root)
    if st.spa then lines[#lines + 1] = "\ttry_files {path} /index.html" end
    if st.browse then
      lines[#lines + 1] = "\tfile_server browse"
    else
      lines[#lines + 1] = "\tfile_server"
    end
    appendSecurity(lines, security)
  elseif typ == "proxy" then
    if security.encode then lines[#lines + 1] = "\tencode zstd gzip" end
    lines[#lines + 1] = "\tlog"
    local p = model.proxy or {}
    local upstreams = p.upstreams
    if type(upstreams) ~= "table" or #upstreams < 1 then return genError("上游不能为空", "proxy.upstreams") end
    for i = 1, #upstreams do
      if type(upstreams[i]) ~= "string" or not validUpstream(upstreams[i]) then
        return genError("上游格式无效", "proxy.upstreams")
      end
    end
    lines[#lines + 1] = "\treverse_proxy " .. table.concat(upstreams, " ") .. " {"
    lines[#lines + 1] = "\t\tlb_policy " .. (p.lbPolicy or "round_robin")
    local health = p.health
    if type(health) == "table" and health.enabled then
      lines[#lines + 1] = "\t\thealth_uri " .. tostring(health.uri or "/health")
      lines[#lines + 1] = "\t\thealth_interval " .. tostring(health.interval or "10s")
      lines[#lines + 1] = "\t\thealth_timeout " .. tostring(health.timeout or "3s")
      lines[#lines + 1] = "\t\thealth_status " .. tostring(health.status or 200)
    end
    if type(p.hostHeader) == "string" and p.hostHeader ~= "" then
      if hasCrLfNul(p.hostHeader) then return genError("Host 头包含非法字符", "proxy.hostHeader") end
      lines[#lines + 1] = "\t\theader_up Host " .. quoteToken(p.hostHeader)
    end

    local hasHttps = false
    for i = 1, #upstreams do
      if upstreams[i]:sub(1, 8) == "https://" then
        hasHttps = true
        break
      end
    end
    local skipVerify = p.skipVerify == true
    local dialTimeout = p.dialTimeout or "5s"
    local responseHeaderTimeout = p.responseHeaderTimeout or "30s"
    local needTls = hasHttps and skipVerify
    local needTransport = needTls or dialTimeout ~= "5s" or responseHeaderTimeout ~= "30s"
    if needTransport then
      lines[#lines + 1] = "\t\ttransport http {"
      if needTls then lines[#lines + 1] = "\t\t\ttls_insecure_skip_verify" end
      lines[#lines + 1] = "\t\t\tdial_timeout " .. dialTimeout
      lines[#lines + 1] = "\t\t\tresponse_header_timeout " .. responseHeaderTimeout
      lines[#lines + 1] = "\t\t}"
    end
    lines[#lines + 1] = "\t}"
    appendSecurity(lines, security)
  elseif typ == "redirect" then
    lines[#lines + 1] = "\tlog"
    local r = model.redirect or {}
    local target = r.target
    if type(target) ~= "string" or target == "" then return genError("重定向目标不能为空", "redirect.target") end
    if hasCrLfNul(target) or hasControl(target) or target:find("%s") then
      return genError("重定向目标包含非法字符", "redirect.target")
    end
    lines[#lines + 1] = "\tredir " .. target .. " " .. tostring(r.code or 301)
  else
    return genError("站点类型无效", "type")
  end

  lines[#lines + 1] = "}"
  local text = table.concat(lines, "\n") .. "\n"
  if #text > M.MAX_SNIPPET then
    return nil, sizeErr("content", "生成的片段超过 48 KiB 限制", { limit = M.MAX_SNIPPET, size = #text })
  end
  return text
end

function M.slugFor(model, takenFn)
  local name = ""
  local domains = nil
  if type(model) == "table" then
    if type(model.name) == "string" then name = model.name end
    domains = model.domains
  end
  return util.slugify(name, domains, takenFn)
end

-- Unique domains across enabled managed sites with automatic HTTPS.
function M.certDomains(items)
  local seen = {}
  local out = util.array({})
  if type(items) ~= "table" then return out end
  for _, item in ipairs(items) do
    if type(item) == "table" and not item.custom and not item.orphan and item.enabled then
      local model = item.model
      if type(model) == "table" and model.https == true and type(model.domains) == "table" then
        for i = 1, #model.domains do
          local d = model.domains[i]
          if type(d) == "string" and d ~= "" then
            local ld = util.lower(d)
            if not seen[ld] then
              seen[ld] = true
              out[#out + 1] = ld
            end
          end
        end
      end
    end
  end
  return out
end

function M.domainIndex(items)
  local map = {}
  if type(items) ~= "table" then return map end
  for _, item in ipairs(items) do
    if type(item) == "table" and not item.custom and not item.orphan and type(item.domains) == "table" then
      for i = 1, #item.domains do
        local d = util.lower(item.domains[i])
        if d ~= "" and map[d] == nil then map[d] = item.slug end
      end
    end
  end
  return map
end

local function certMapOf(certMap)
  local map = {}
  if type(certMap) ~= "table" then return map end
  for k, v in pairs(certMap) do
    if type(v) == "table" then
      if type(k) == "string" then
        map[util.lower(k)] = v
      elseif type(k) == "number" and type(v.domain) == "string" then
        map[util.lower(v.domain)] = v
      end
    end
  end
  return map
end

-- List summary used by GET /sites.
function M.summary(item, certMap)
  local domains = util.array({})
  if type(item.domains) == "table" then
    for i = 1, #item.domains do domains[#domains + 1] = item.domains[i] end
  end

  local cert = nil
  local map = certMapOf(certMap)
  local first = nil
  local best = nil
  local bestDays = nil
  local now = util.nowEpoch()
  for i = 1, #domains do
    local rec = map[util.lower(domains[i])]
    if rec then
      local notAfter = type(rec.not_after) == "string" and rec.not_after or ""
      local epoch = util.parseUTC(notAfter)
      local days = nil
      if epoch then days = util.daysUntil(epoch, now) end
      if not first then first = { rec = rec, days = days } end
      if days ~= nil and (bestDays == nil or days < bestDays) then
        bestDays = days
        best = { rec = rec, days = days }
      end
    end
  end
  local pick = best or first
  if pick then
    cert = {
      expiresAt = type(pick.rec.not_after) == "string" and pick.rec.not_after or "",
      days = pick.days,
      expiring = pick.days ~= nil and pick.days <= 14,
      error = type(pick.rec.error) == "string" and pick.rec.error or "",
    }
  end

  return {
    slug = item.slug,
    name = item.name,
    group = item.group,
    note = item.note,
    type = item.type,
    domains = domains,
    enabled = item.enabled == true,
    custom = item.custom == true,
    orphan = item.orphan == true,
    conflict = item.conflict == true,
    updatedAt = item.updatedAt or "",
    createdAt = item.createdAt or "",
    cert = cert,
  }
end

M.publicSummary = M.summary

return M
