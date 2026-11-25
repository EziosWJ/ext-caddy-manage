-- store.lua — SQLite metadata (site rows, cert cache, meta keys).
-- host.storage calls throw on failure; every public function catches them and
-- returns nil, err (or false, err) instead. Never log model JSON here.
local util = require("util")

local M = {}

local SITE_COLUMNS =
  "slug, name, group_name, note, type, model, last_content, enabled, created_at, updated_at"

local ERROR_KEEP = 10
local ERROR_MESSAGE_LIMIT = 2000
local ERROR_DEDUPE_SECONDS = 300

local function query(sql, args)
  local ok, rows = pcall(host.storage.query, sql, args or util.array({}))
  if not ok then return nil, tostring(rows) end
  if type(rows) ~= "table" then rows = util.array({}) end
  return rows
end

local function exec(sql, args)
  local ok, affected = pcall(host.storage.exec, sql, args or util.array({}))
  if not ok then return nil, tostring(affected) end
  return tonumber(affected) or 0
end

local function asBool(value)
  if value == true then return true end
  if value == false then return false end
  local number = tonumber(value)
  return number ~= nil and number ~= 0
end

local function siteRow(row)
  return {
    slug = type(row.slug) == "string" and row.slug or "",
    name = type(row.name) == "string" and row.name or "",
    group_name = type(row.group_name) == "string" and row.group_name or "",
    note = type(row.note) == "string" and row.note or "",
    type = type(row.type) == "string" and row.type or "",
    model = type(row.model) == "string" and row.model or "",
    last_content = type(row.last_content) == "string" and row.last_content or "",
    enabled = asBool(row.enabled),
    created_at = type(row.created_at) == "string" and row.created_at or "",
    updated_at = type(row.updated_at) == "string" and row.updated_at or "",
  }
end

local function modelText(value)
  if type(value) == "string" then return value end
  if type(value) == "table" then
    local encoded, err = util.jsonEncode(value)
    if not encoded then return nil, err end
    return encoded
  end
  return nil, "model 必须是 JSON 字符串"
end

function M.ensure()
  local ok, err = pcall(function()
    host.storage.exec([[
CREATE TABLE IF NOT EXISTS sites (
  slug         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  group_name   TEXT NOT NULL DEFAULT '默认',
  note         TEXT NOT NULL DEFAULT '',
  type         TEXT NOT NULL,
  model        TEXT NOT NULL,
  last_content TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
)]])
    host.storage.exec([[
CREATE TABLE IF NOT EXISTS cert_cache (
  domain     TEXT PRIMARY KEY,
  issuer     TEXT NOT NULL DEFAULT '',
  not_after  TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT '',
  error      TEXT NOT NULL DEFAULT ''
)]])
    host.storage.exec([[
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)]])
    local rows = host.storage.query("SELECT value FROM meta WHERE key = ?", { "schema_version" })
    if not rows or #rows == 0 then
      host.storage.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        { "schema_version", "1" }
      )
    end
  end)
  if not ok then return false, tostring(err) end
  return true
end

function M.metaGet(key)
  if type(key) ~= "string" or key == "" then return nil, "meta key 无效" end
  local rows, err = query("SELECT value FROM meta WHERE key = ?", { key })
  if not rows then return nil, err end
  if #rows == 0 then return nil end
  return rows[1].value
end

function M.metaSet(key, value)
  if type(key) ~= "string" or key == "" then return false, "meta key 无效" end
  if value == nil then return M.metaDelete(key) end
  if type(value) == "number" or type(value) == "boolean" then
    value = tostring(value)
  end
  if type(value) ~= "string" then return false, "meta value 必须是字符串" end
  local affected, err = exec(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    { key, value }
  )
  if affected == nil then return false, err end
  return true
end

function M.metaDelete(key)
  if type(key) ~= "string" or key == "" then return false, "meta key 无效" end
  local affected, err = exec("DELETE FROM meta WHERE key = ?", { key })
  if affected == nil then return false, err end
  return true
end

function M.listSites()
  local rows, err = query(
    "SELECT " .. SITE_COLUMNS .. " FROM sites ORDER BY name COLLATE NOCASE, slug"
  )
  if not rows then return nil, err end
  local out = util.array({})
  for i = 1, #rows do
    out[i] = siteRow(rows[i])
  end
  return out
end

function M.getSite(slug)
  if type(slug) ~= "string" or slug == "" then return nil, "slug 无效" end
  local rows, err = query("SELECT " .. SITE_COLUMNS .. " FROM sites WHERE slug = ?", { slug })
  if not rows then return nil, err end
  if #rows == 0 then return nil end
  return siteRow(rows[1])
end

function M.saveSite(row)
  if type(row) ~= "table" then return false, "站点记录无效" end
  local slug = row.slug
  if type(slug) ~= "string" or not util.safeSlug(slug) then return false, "slug 无效" end
  local name = row.name
  if type(name) ~= "string" or util.trim(name) == "" then return false, "站点名称无效" end
  local siteType = row.type
  if type(siteType) ~= "string" or siteType == "" then return false, "站点类型无效" end
  local group = row.group_name
  if group == nil then group = row.group end
  if type(group) ~= "string" then group = "默认" end
  local note = row.note
  if type(note) ~= "string" then note = "" end
  local model, modelErr = modelText(row.model)
  if not model then return false, modelErr end
  local lastContent = row.last_content
  if type(lastContent) ~= "string" then lastContent = "" end
  local createdAt = row.created_at
  if type(createdAt) ~= "string" or createdAt == "" then createdAt = util.nowUTC() end
  local updatedAt = row.updated_at
  if type(updatedAt) ~= "string" or updatedAt == "" then updatedAt = util.nowUTC() end
  -- The schema default is enabled=1; treat an omitted flag as enabled.
  local enabledValue = row.enabled
  if enabledValue == nil then enabledValue = true end
  enabledValue = asBool(enabledValue) and 1 or 0

  local affected, err = exec([[
INSERT INTO sites (slug, name, group_name, note, type, model, last_content, enabled, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(slug) DO UPDATE SET
  name = excluded.name,
  group_name = excluded.group_name,
  note = excluded.note,
  type = excluded.type,
  model = excluded.model,
  last_content = excluded.last_content,
  enabled = excluded.enabled,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at
]], {
    slug, name, group, note, siteType, model, lastContent,
    enabledValue, createdAt, updatedAt,
  })
  if affected == nil then return false, err end
  return true
end

function M.updateSiteContent(slug, modelJson, lastContent, enabled, updatedAt)
  if type(slug) ~= "string" or not util.safeSlug(slug) then return false, "slug 无效" end
  if type(lastContent) ~= "string" then return false, "片段内容无效" end
  local model = nil
  if modelJson ~= nil then
    local modelErr
    model, modelErr = modelText(modelJson)
    if not model then return false, modelErr end
  end
  if type(updatedAt) ~= "string" or updatedAt == "" then updatedAt = util.nowUTC() end
  local enabledValue = enabled
  if enabledValue == nil then enabledValue = true end
  enabledValue = asBool(enabledValue) and 1 or 0

  local affected, err
  if model == nil then
    affected, err = exec(
      "UPDATE sites SET last_content = ?, enabled = ?, updated_at = ? WHERE slug = ?",
      { lastContent, enabledValue, updatedAt, slug }
    )
  else
    affected, err = exec(
      "UPDATE sites SET model = ?, last_content = ?, enabled = ?, updated_at = ? WHERE slug = ?",
      { model, lastContent, enabledValue, updatedAt, slug }
    )
  end
  if affected == nil then return false, err end
  return true
end

function M.deleteSite(slug)
  if type(slug) ~= "string" or slug == "" then return false, "slug 无效" end
  local affected, err = exec("DELETE FROM sites WHERE slug = ?", { slug })
  if affected == nil then return false, err end
  return true
end

function M.listCerts()
  local rows, err = query(
    "SELECT domain, issuer, not_after, checked_at, error FROM cert_cache ORDER BY domain"
  )
  if not rows then return nil, err end
  local out = util.array({})
  for i = 1, #rows do
    local row = rows[i]
    out[i] = {
      domain = type(row.domain) == "string" and row.domain or "",
      issuer = type(row.issuer) == "string" and row.issuer or "",
      not_after = type(row.not_after) == "string" and row.not_after or "",
      checked_at = type(row.checked_at) == "string" and row.checked_at or "",
      error = type(row.error) == "string" and row.error or "",
    }
  end
  return out
end

function M.upsertCert(domain, issuer, notAfter, checkedAt, errText)
  if type(domain) ~= "string" or domain == "" then return false, "域名无效" end
  local function text(value)
    if type(value) == "string" then return value end
    return ""
  end
  local affected, err = exec([[
INSERT INTO cert_cache (domain, issuer, not_after, checked_at, error)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(domain) DO UPDATE SET
  issuer = excluded.issuer,
  not_after = excluded.not_after,
  checked_at = excluded.checked_at,
  error = excluded.error
]], { domain, text(issuer), text(notAfter), text(checkedAt), text(errText) })
  if affected == nil then return false, err end
  return true
end

local function errorList(value)
  local out = util.array({})
  if type(value) ~= "table" then return out end
  for i = 1, #value do
    local item = value[i]
    if type(item) == "table" then
      out[#out + 1] = {
        time = type(item.time) == "string" and item.time or "",
        scope = type(item.scope) == "string" and item.scope or "",
        message = type(item.message) == "string" and item.message or "",
      }
    end
  end
  return out
end

function M.recordError(scope, message)
  local scopeText = type(scope) == "string" and scope or "unknown"
  local messageText = message
  if type(messageText) ~= "string" then messageText = tostring(messageText) end
  if #messageText > ERROR_MESSAGE_LIMIT then
    messageText = messageText:sub(1, ERROR_MESSAGE_LIMIT)
  end

  local raw, readErr = M.metaGet("recent_errors")
  if readErr then return false, readErr end
  local list = util.array({})
  if type(raw) == "string" and raw ~= "" then
    local existing = errorList(util.jsonDecode(raw))
    for i = 1, #existing do
      list[#list + 1] = existing[i]
    end
  end
  -- A polling log panel or a repeated retry can produce the same failure every
  -- second; keep one entry per five minutes instead of writing and flooding.
  local last = list[#list]
  if type(last) == "table" and last.scope == scopeText and last.message == messageText then
    local lastEpoch = util.parseUTC(type(last.time) == "string" and last.time or "")
    if lastEpoch and util.nowEpoch() - lastEpoch < ERROR_DEDUPE_SECONDS then
      return true
    end
  end
  list[#list + 1] = { time = util.nowUTC(), scope = scopeText, message = messageText }
  while #list > ERROR_KEEP do
    table.remove(list, 1)
  end
  local encoded, encodeErr = util.jsonEncode(list)
  if not encoded then return false, encodeErr end
  return M.metaSet("recent_errors", encoded)
end

function M.recentErrors()
  local raw, err = M.metaGet("recent_errors")
  if err then return nil, err end
  if type(raw) ~= "string" or raw == "" then return util.array({}) end
  return errorList(util.jsonDecode(raw))
end

return M
