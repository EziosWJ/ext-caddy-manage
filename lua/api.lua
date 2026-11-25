-- api.lua: HTTP route handlers for the Caddy management plugin.
-- Every handler returns a response table built with the http helpers.

local util = require("util")
local fs = require("fs")
local http = require("http")
local settings = require("settings")
local caddy = require("caddy")
local store = require("store")
local sites = require("sites")
local services = require("services")
local logs = require("logs")
local certs = require("certs")
local apply = require("apply")
local discovery = require("discovery")
local metrics = require("metrics")
local sitecheck = require("sitecheck")

local M = {}

local BODY_LIMIT = 1024 * 1024
local VERSION_TTL_SECONDS = 300
local validateSeq = 0

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------

local function cap(s, limit)
  if type(s) ~= "string" then return "" end
  limit = limit or 2000
  if #s > limit then return string.sub(s, 1, limit) end
  return s
end

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
  if type(e) ~= "table" then return "命令执行失败" end
  local out = caddyOutput(e)
  local line = string.match(out, "^([^\r\n]*)") or ""
  if line == "" and type(e.message) == "string" then line = e.message end
  if line == "" then line = "命令执行失败" end
  return cap(line)
end

-- Only operational failures belong in the overview's "recent errors" card;
-- user input and conflict responses are already visible in context.
local RECENT_ERROR_CODES = {
  validate_failed = true,
  reload_failed = true,
  rollback_failed = true,
  caddy_missing = true,
  privilege_missing = true,
  service_error = true,
  journal_unavailable = true,
}

local function failFrom(e, scope)
  if type(e) ~= "table" then
    e = { code = "internal", message = tostring(e) }
  end
  local code = e.code or "internal"
  local message = e.message or "操作失败"
  if RECENT_ERROR_CODES[code] then
    pcall(store.recordError, scope or "apply", message)
  end
  return http.fail(code, message, e.details, e.status)
end

local function readBody(request)
  local body, errResponse = http.body(request, BODY_LIMIT)
  if not body then return nil, errResponse end
  return body
end

local function isPlainObject(value)
  if type(value) ~= "table" or util.isArray(value) then return false end
  for key in pairs(value) do
    if type(key) ~= "string" then return false end
  end
  return true
end

local function optionalStringField(body, key)
  local value = body[key]
  if value == nil then return nil, nil end
  if type(value) ~= "string" then
    return nil, http.fail("bad_request", key .. " 必须是字符串", { field = key })
  end
  return value, nil
end

local function optionalBoolField(body, key, default)
  local value = body[key]
  if value == nil then return default, nil end
  if type(value) ~= "boolean" then
    return nil, http.fail("bad_request", key .. " 必须是布尔值", { field = key })
  end
  return value, nil
end

local function queryString(request, name, default)
  local value, errResponse = http.queryString(request, name, default)
  if errResponse then return nil, errResponse end
  return value
end

local function queryInt(request, name, default, min, max)
  local value, errResponse = http.queryInt(request, name, default, min, max)
  if errResponse then return nil, errResponse end
  return value
end

local function truthyQuery(value)
  if value == nil then return false end
  local s = util.lower(tostring(value))
  return s == "1" or s == "true" or s == "yes" or s == "on"
end

local function dbCall(fn, ...)
  local pok, res, err = pcall(fn, ...)
  if not pok then return false, tostring(res) end
  if err ~= nil then return false, tostring(err) end
  if res == false then return false, "数据库操作失败" end
  return true
end

local function metaGetRaw(key)
  local pok, value = pcall(store.metaGet, key)
  if pok and type(value) == "string" then return value end
  return nil
end

local function metaGetJson(key)
  local value = metaGetRaw(key)
  if value == nil or value == "" then return nil end
  local decoded = util.jsonDecode(value)
  if type(decoded) ~= "table" then return nil end
  return decoded
end

local function metaSetRaw(key, value)
  if type(value) ~= "string" then return false end
  local ok, result = pcall(store.metaSet, key, value)
  return ok and result == true
end

local function metaSetJson(key, value)
  local text = util.jsonEncode(value)
  if type(text) ~= "string" then return false end
  return metaSetRaw(key, text)
end

-- ---------------------------------------------------------------------------
-- Sites helpers
-- ---------------------------------------------------------------------------

local function siteCounts(items)
  local counts = { total = 0, enabled = 0, disabled = 0, custom = 0, orphan = 0, conflict = 0 }
  for _, item in ipairs(items or {}) do
    counts.total = counts.total + 1
    if item.enabled then
      counts.enabled = counts.enabled + 1
    else
      counts.disabled = counts.disabled + 1
    end
    if item.custom then counts.custom = counts.custom + 1 end
    if item.orphan then counts.orphan = counts.orphan + 1 end
    if item.conflict then counts.conflict = counts.conflict + 1 end
  end
  return counts
end

local function collectGroups(items)
  local seen, out = {}, {}
  for _, item in ipairs(items or {}) do
    local group = item.group
    if type(group) == "string" and group ~= "" and not seen[group] then
      seen[group] = true
      out[#out + 1] = group
    end
  end
  table.sort(out)
  return util.array(out)
end

local function siteCert(item, now)
  if item.custom or item.orphan then return nil end
  local domains = sites.modelCertDomains(item.model)
  if #domains == 0 then return nil end
  local pok, list = pcall(certs.forDomains, domains, now)
  if not pok or type(list) ~= "table" then return nil end
  local best, bestDays = nil, nil
  for _, entry in ipairs(list) do
    if type(entry) == "table" then
      local days = entry.days
      if type(days) == "number" then
        if bestDays == nil or days < bestDays then
          best = entry
          bestDays = days
        end
      elseif best == nil then
        best = entry
      end
    end
  end
  if best == nil then return nil end
  return {
    expiresAt = best.not_after or "",
    days = best.days,
    expiring = best.expiring and true or false,
    error = best.error or "",
  }
end

local function siteSummary(item, now)
  local domains = item.domains
  if type(domains) ~= "table" then domains = {} end
  return {
    slug = item.slug,
    name = item.name,
    group = item.group or "",
    note = item.note or "",
    type = item.type or "custom",
    domains = util.array(domains),
    urls = sites.accessUrls(item.model),
    enabled = item.enabled and true or false,
    custom = item.custom and true or false,
    orphan = item.orphan and true or false,
    conflict = item.conflict and true or false,
    updatedAt = item.updatedAt or "",
    createdAt = item.createdAt or "",
    cert = siteCert(item, now),
  }
end

local function siteBackups(slug, limit)
  limit = limit or 10
  local out = util.array({})
  local list = fs.listBackups() or {}
  local target = slug .. ".caddy"
  for _, entry in ipairs(list) do
    if entry.scope == "site" and entry.target == target then
      out[#out + 1] = entry
      if #out >= limit then break end
    end
  end
  return out
end

local function siteDetailData(slug)
  local pok, item, gerr = pcall(sites.get, slug)
  if not pok then
    return nil, { code = "internal", message = "读取站点失败：" .. tostring(item) }
  end
  if not item then return nil, gerr end
  local now = util.nowEpoch()
  local domains = item.domains
  if type(domains) ~= "table" then domains = {} end
  local certList = util.array({})
  local certDomains = sites.modelCertDomains(item.model)
  if #certDomains > 0 then
    local cok, list = pcall(certs.forDomains, certDomains, now)
    if cok and type(list) == "table" then certList = util.array(list) end
  end
  local data = {
    slug = item.slug,
    name = item.name,
    group = item.group or "",
    note = item.note or "",
    type = item.type,
    domains = util.array(domains),
    urls = sites.accessUrls(item.model),
    enabled = item.enabled and true or false,
    custom = item.custom and true or false,
    orphan = item.orphan and true or false,
    conflict = item.conflict and true or false,
    model = item.model,
    raw = item.raw,
    lastContent = item.lastContent,
    drift = item.drift and true or false,
    path = item.path,
    size = item.size or 0,
    mtime = item.mtime or 0,
    createdAt = item.createdAt or "",
    updatedAt = item.updatedAt or "",
    certs = certList,
    backups = siteBackups(slug, 10),
    logLines = settings.load().logLines,
  }
  if item.modelError then data.modelError = true end
  if item.model and type(item.raw) == "string" then
    local ok, generated = pcall(sites.generate, item.model)
    if ok and generated then data.formMatchesFile = generated == item.raw end
  end
  return data
end

local function siteOrFail(slug)
  local pok, item, gerr = pcall(sites.get, slug)
  if not pok then
    return nil, http.fail("internal", "读取站点失败：" .. tostring(item))
  end
  if not item then
    return nil, failFrom(gerr or { code = "not_found", message = "站点不存在" })
  end
  return item
end

local function modelJsonFor(slug, item)
  local pok, row = pcall(store.getSite, slug)
  if pok and type(row) == "table" and type(row.model) == "string" then
    return row.model
  end
  local encoded = util.jsonEncode(item.model or {})
  if type(encoded) == "string" then return encoded end
  return "{}"
end

-- ---------------------------------------------------------------------------
-- Service helpers
-- ---------------------------------------------------------------------------

local function serviceView()
  local s = settings.load()
  local unit = s.serviceUnit
  local pok, detail, serr = pcall(services.get, unit)
  if not pok then
    serr = { code = "service_error", message = "无法获取服务状态：" .. tostring(detail) }
    detail = nil
  end
  if not detail then
    local code = "service_error"
    local message = "无法获取服务状态"
    if type(serr) == "table" then
      code = serr.code or code
      message = serr.message or message
    end
    return {
      available = false,
      unit = unit,
      running = false,
      state = "unknown",
      stateDetail = "",
      bootState = "",
      activeEnterTimestamp = "",
      fragmentPath = "",
      error = { code = code, message = message },
    }
  end
  local state = detail.state or "unknown"
  return {
    available = true,
    unit = unit,
    running = state == "running",
    state = state,
    stateDetail = detail.stateDetail or "",
    bootState = detail.bootState or "",
    mainPid = detail.mainPid,
    memoryBytes = detail.memoryBytes,
    cpuUsageNs = detail.cpuUsageNs,
    activeEnterTimestamp = detail.activeEnterTimestamp or "",
    fragmentPath = detail.fragmentPath or "",
  }
end

-- Build an argument that works whether certs.* expects the sites.loadAll()
-- result or the plain item array (both shapes are exposed).
local function sitesArg(data)
  local items = {}
  if type(data) == "table" then
    if type(data.items) == "table" then items = data.items else items = data end
  end
  local arg = { items = items }
  for i = 1, #items do arg[i] = items[i] end
  if type(data) == "table" then
    if type(data.bySlug) == "table" then arg.bySlug = data.bySlug end
    if type(data.domains) == "table" then arg.domains = data.domains end
  end
  return arg
end

local function certListFor(data, now)
  local pok, list = pcall(certs.list, sitesArg(data), now)
  if pok and type(list) == "table" then return util.array(list) end
  return util.array({})
end

local function backupForGlobal(limit)
  local out = util.array({})
  local list = fs.listBackups() or {}
  for _, entry in ipairs(list) do
    if entry.scope == "global" then
      out[#out + 1] = entry
      if #out >= limit then break end
    end
  end
  return out
end

-- ---------------------------------------------------------------------------
-- /health and /overview
-- ---------------------------------------------------------------------------

local function h_health(request)
  local s = settings.load()
  local raw, exists, readErr = fs.readExisting(s.mainConfig)
  local initialized = exists and readErr == nil
  local hasMarkers = false
  local hasImport = false
  if raw ~= nil then
    local parsed = apply.parseGlobal(raw)
    hasMarkers = parsed and parsed.hasMarkers or false
    hasImport = apply.hasSnippetImport(raw, s)
  end
  return http.ok({
    ready = true,
    initialized = initialized and true or false,
    hasMarkers = hasMarkers and true or false,
    hasImport = hasImport and true or false,
    mainConfig = s.mainConfig,
    snippetDir = s.snippetDir,
    sitesRoot = s.sitesRoot,
    unit = s.serviceUnit,
    logLines = s.logLines,
  })
end

local function cachedVersion(path)
  local cache = metaGetJson("caddy.version")
  local now = util.nowEpoch()
  if type(cache) == "table"
    and cache.path == path
    and type(cache.at) == "number"
    and type(cache.version) == "string" then
    local age = now - cache.at
    if age >= 0 and age < VERSION_TTL_SECONDS then
      return cache.version
    end
  end
  local result = caddy.version()
  if type(result) == "table" and result.ok then
    local version = result.version
    if type(version) ~= "string" then version = "" end
    metaSetJson("caddy.version", { path = path, version = version, at = now })
    return version
  end
  return nil
end

local function mainHasMarkers()
  local s = settings.load()
  local raw = fs.read(s.mainConfig)
  if raw == nil then return false, false end
  local parsed = apply.parseGlobal(raw)
  return true, parsed and parsed.hasMarkers or false
end

local function h_overview(request)
  local s = settings.load()
  local data = sites.loadAll()
  local items = data.items or {}
  local now = util.nowEpoch()
  local counts = siteCounts(items)
  local certList = certListFor(data, now)
  local expiring, unknown = 0, 0
  for _, entry in ipairs(certList) do
    if entry.expiring then expiring = expiring + 1 end
    if entry.days == nil then unknown = unknown + 1 end
  end
  local version = cachedVersion(s.caddyBinary)
  if version == "" then version = nil end
  local initialized, hasMarkers = mainHasMarkers()
  local pok, recentRaw = pcall(store.recentErrors)
  local recent = util.array({})
  if pok and type(recentRaw) == "table" then recent = util.array(recentRaw) end
  local lastError = nil
  -- store.recordError appends the newest entry at the end.
  if #recent > 0 and type(recent[#recent]) == "table" then lastError = recent[#recent].message end
  return http.ok({
    service = serviceView(),
    caddyVersion = version,
    sites = {
      total = counts.total,
      enabled = counts.enabled,
      disabled = counts.disabled,
      custom = counts.custom,
      orphan = counts.orphan,
      groups = collectGroups(items),
    },
    certs = { items = certList, expiring = expiring, unknown = unknown },
    recentErrors = recent,
    initialized = initialized,
    hasMarkers = hasMarkers,
    lastError = lastError,
    logLines = s.logLines,
  })
end

-- ---------------------------------------------------------------------------
-- Sites
-- ---------------------------------------------------------------------------

local function h_sites(request)
  local data = sites.loadAll()
  local items = data.items or {}
  local now = util.nowEpoch()
  local out = util.array({})
  for _, item in ipairs(items) do
    out[#out + 1] = siteSummary(item, now)
  end
  return http.ok({
    items = out,
    counts = siteCounts(items),
    groups = collectGroups(items),
    warnings = util.array(data.warnings or {}),
  })
end

local function h_site(request)
  local slug, serr = queryString(request, "slug", nil)
  if serr then return serr end
  if type(slug) ~= "string" or util.trim(slug) == "" then
    return http.fail("bad_request", "缺少 slug 参数", { field = "slug" })
  end
  local data, gerr = siteDetailData(slug)
  if not data then
    return failFrom(gerr or { code = "not_found", message = "站点不存在" })
  end
  return http.ok(data)
end

local function h_localListeners()
  return http.ok(discovery.list(settings.load()))
end

local function h_probeListener(request)
  local body, err = readBody(request)
  if not body then return err end
  local candidate, message = discovery.find(settings.load(), body.candidateId)
  if not candidate then return http.fail("conflict", message, { field = "candidateId" }) end
  return http.ok(discovery.probe(candidate))
end

local function h_siteCreate(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local model = body.model
  if type(model) ~= "table" then
    return http.fail("bad_request", "缺少站点模型 model", { field = "model" })
  end
  local s = settings.load()
  local data = sites.loadAll()
  local taken = function(slug)
    if type(data.bySlug) == "table" and data.bySlug[slug] ~= nil then return true end
    if fs.exists(sites.snippetPath(slug, true)) then return true end
    if fs.exists(sites.snippetPath(slug, false)) then return true end
    return false
  end
  local slug = sites.slugFor(model, taken)
  if type(slug) ~= "string" or slug == "" then
    return http.fail("internal", "无法生成站点 slug")
  end
  if model.type == "static" and model.static == nil then
    model.static = { root = util.join(s.sitesRoot, slug) }
  elseif model.type == "static" and isPlainObject(model.static) then
    local root = model.static.root
    if root == nil or (type(root) == "string" and util.trim(root) == "") then
      model.static.root = util.join(s.sitesRoot, slug)
    end
  end
  local normalized, verr = sites.validate(model, { slug = slug, creating = true, sites = data })
  if not normalized then return failFrom(verr) end
  local publish = body.publish
  if publish ~= nil then
    if not isPlainObject(publish) or not normalized.access then
      return http.fail("bad_request", "快速发布需要明确配置访问入口", { field = "access.scope" })
    end
    if normalized.access.scope == "all" and publish.confirmAll ~= true then
      return http.fail("bad_request", "请确认所有接口的暴露范围", { field = "confirmAll" })
    end
    local candidate
    if publish.candidateId ~= nil then
      local message
      candidate, message = discovery.find(s, publish.candidateId)
      if not candidate then return http.fail("conflict", message, { field = "candidateId" }) end
    end
    local field, message = discovery.checkPublish(s, normalized, candidate)
    if field then return http.fail("invalid_model", message, { field = field }) end
  end
  local content, gerr = sites.generate(normalized)
  if type(content) ~= "string" or content == "" then
    if gerr then return failFrom(gerr) end
    return http.fail("internal", "生成站点片段失败", { slug = slug })
  end
  local res, aerr = apply.writeSite({
    slug = slug,
    content = content,
    enabled = true,
    allowCreate = true,
    reason = "create",
  })
  if not res then
    if publish and aerr then
      aerr.details = aerr.details or {}
      local rollback = aerr.details.rollback
      aerr.details.publication = {
        saved = rollback and not rollback.restored and "unknown" or "no",
        loaded = "no",
      }
    end
    return failFrom(aerr)
  end

  local modelJson = util.jsonEncode(normalized)
  if type(modelJson) ~= "string" then
    local ok, cleanup = pcall(apply.deleteSiteFile, slug, nil)
    return http.fail("internal", "站点模型序列化失败", {
      slug = slug, publication = { saved = ok and cleanup and "no" or "unknown", loaded = "unknown" },
    })
  end
  local now = util.nowUTC()
  local row = {
    slug = slug,
    name = normalized.name,
    group_name = normalized.group or "默认",
    note = normalized.note or "",
    type = normalized.type,
    model = modelJson,
    last_content = content,
    enabled = true,
    created_at = now,
    updated_at = now,
  }
  local dbOk, dbErr = dbCall(store.saveSite, row)
  if not dbOk then
    local ok, cleanup = pcall(apply.deleteSiteFile, slug, nil)
    return http.fail("internal", "站点已写入但元数据保存失败：" .. tostring(dbErr), {
      slug = slug, publication = { saved = ok and cleanup and "no" or "unknown", loaded = "unknown" },
    })
  end
  local detail = siteDetailData(slug)
  if not detail then
    return http.fail("internal", "站点已创建但读取详情失败", {
      slug = slug, publication = { saved = "yes", loaded = res.apply.reloaded and "yes" or "no" },
    })
  end
  detail.apply = res.apply
  return http.ok(detail)
end

local function prepareSiteUpdate(body)
  local slug = http.str(body, "slug")
  if type(slug) ~= "string" or util.trim(slug) == "" then
    return nil, http.fail("bad_request", "缺少 slug 参数", { field = "slug" })
  end
  local model = body.model
  if type(model) ~= "table" then
    return nil, http.fail("bad_request", "缺少站点模型 model", { field = "model" })
  end
  local item, ierr = siteOrFail(slug)
  if not item then return nil, ierr end
  if item.custom then
    return nil, http.fail("bad_request", "自定义片段只能编辑原文", { slug = slug })
  end
  if item.orphan then
    return nil, http.fail("not_found", "站点片段不存在，可能已被外部删除", { slug = slug })
  end
  local data = sites.loadAll()
  local normalized, verr = sites.validate(model, {
    slug = slug,
    creating = false,
    existing = item.model or { type = item.type },
    sites = data,
  })
  if not normalized then return nil, failFrom(verr) end
  local content, gerr = sites.generate(normalized)
  if type(content) ~= "string" or content == "" then
    if gerr then return nil, failFrom(gerr) end
    return nil, http.fail("internal", "生成站点片段失败", { slug = slug })
  end
  return { slug = slug, item = item, model = normalized, content = content }
end

local function h_sitePreview(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local prepared, perr = prepareSiteUpdate(body)
  if not prepared then return perr end
  return http.ok({ content = prepared.content })
end

local function h_siteUpdate(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local prepared, perr = prepareSiteUpdate(body)
  if not prepared then return perr end
  local slug, item, normalized, content = prepared.slug, prepared.item, prepared.model, prepared.content
  local baseline, baselineErr = optionalStringField(body, "baseline")
  if baselineErr then return baselineErr end
  local force, forceErr = optionalBoolField(body, "force", false)
  if forceErr then return forceErr end
  local res, aerr = apply.writeSite({
    slug = slug,
    content = content,
    enabled = item.enabled,
    baseline = baseline,
    force = force,
    reason = "form",
    allowCreate = false,
  })
  if not res then return failFrom(aerr) end
  local modelJson = util.jsonEncode(normalized)
  local dbOk, dbErr = false, "站点模型序列化失败"
  if type(modelJson) == "string" then
    -- A form save can rename the site or change its group/note, so refresh the
    -- metadata columns too; otherwise GET /sites would keep showing stale data.
    local now = util.nowUTC()
    local oldRow = nil
    local rowOk, row = pcall(store.getSite, slug)
    if rowOk and type(row) == "table" then oldRow = row end
    local saveRow = {
      slug = slug,
      name = normalized.name,
      group_name = normalized.group or "默认",
      note = normalized.note or "",
      type = normalized.type,
      model = modelJson,
      last_content = content,
      enabled = item.enabled,
      created_at = (oldRow and oldRow.created_at) or item.createdAt or now,
      updated_at = now,
    }
    dbOk, dbErr = dbCall(store.saveSite, saveRow)
  end
  if not dbOk then
    return http.fail("internal", "配置已保存但元数据更新失败：" .. tostring(dbErr), {
      slug = slug,
      apply = res.apply,
    })
  end
  local detail = siteDetailData(slug)
  if not detail then
    return http.fail("internal", "读取站点详情失败", { slug = slug })
  end
  detail.apply = res.apply
  return http.ok(detail)
end

local function h_siteRaw(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local slug = http.str(body, "slug")
  if type(slug) ~= "string" or util.trim(slug) == "" then
    return http.fail("bad_request", "缺少 slug 参数", { field = "slug" })
  end
  local content, contentErr = optionalStringField(body, "content")
  if contentErr then return contentErr end
  if content == nil then
    return http.fail("bad_request", "缺少 content 参数", { field = "content" })
  end
  if content == "" then
    return http.fail("bad_request", "站点片段内容不能为空")
  end
  if #content > fs.LIMIT then
    return http.fail("size_limit", "站点片段超过 48 KiB 限制", { bytes = #content, limit = fs.LIMIT })
  end
  local item, ierr = siteOrFail(slug)
  if not item then return ierr end
  if item.orphan then
    return http.fail("not_found", "站点片段不存在，可能已被外部删除", { slug = slug })
  end
  local baseline, baselineErr = optionalStringField(body, "baseline")
  if baselineErr then return baselineErr end
  local force, forceErr = optionalBoolField(body, "force", false)
  if forceErr then return forceErr end
  local res, aerr = apply.writeSite({
    slug = slug,
    content = content,
    enabled = item.enabled,
    baseline = baseline,
    force = force,
    reason = "raw",
    allowCreate = false,
  })
  if not res then return failFrom(aerr) end
  if not item.custom then
    local modelJson = modelJsonFor(slug, item)
    local dbOk, dbErr = dbCall(store.updateSiteContent, slug, modelJson, content, item.enabled, util.nowUTC())
    if not dbOk then
      return http.fail("internal", "原文已保存但元数据更新失败：" .. tostring(dbErr), {
        slug = slug,
        apply = res.apply,
      })
    end
  end
  local detail = siteDetailData(slug)
  if not detail then
    return http.fail("internal", "读取站点详情失败", { slug = slug })
  end
  detail.apply = res.apply
  return http.ok(detail)
end

local function h_siteValidate(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local content, contentErr = optionalStringField(body, "content")
  if contentErr then return contentErr end
  if content == nil then
    return http.fail("bad_request", "缺少 content 参数", { field = "content" })
  end
  if #content > fs.LIMIT then
    return http.fail("size_limit", "站点片段超过 48 KiB 限制", { bytes = #content, limit = fs.LIMIT })
  end
  local result = caddy.validateSnippet(content)
  if not (type(result) == "table" and result.ok) then
    local e = type(result) == "table" and result.error or nil
    return http.fail("validate_failed", "站点片段校验失败：" .. caddyMessage(e), {
      output = cap(caddyOutput(e), 8192),
    })
  end
  return http.ok({ valid = true, bytes = #content })
end

local function setEnabledHandler(request, enabled)
  local body, berr = readBody(request)
  if not body then return berr end
  local slug = http.str(body, "slug")
  if type(slug) ~= "string" or util.trim(slug) == "" then
    return http.fail("bad_request", "缺少 slug 参数", { field = "slug" })
  end
  local item, ierr = siteOrFail(slug)
  if not item then return ierr end
  if item.orphan then
    return http.fail("not_found", "站点片段不存在，可能已被外部删除", { slug = slug })
  end
  local baseline, baselineErr = optionalStringField(body, "baseline")
  if baselineErr then return baselineErr end
  local res, aerr = apply.setEnabled(slug, enabled, baseline)
  if not res then return failFrom(aerr) end
  if not item.custom then
    local modelJson = modelJsonFor(slug, item)
    local dbOk, dbErr = dbCall(store.updateSiteContent, slug, modelJson, item.lastContent or "",
      enabled, util.nowUTC())
    if not dbOk then
      return http.fail("internal", "站点状态已变更但元数据更新失败：" .. tostring(dbErr), {
        slug = slug,
        apply = res.apply,
      })
    end
  end
  local detail = siteDetailData(slug)
  if not detail then
    return http.fail("internal", "读取站点详情失败", { slug = slug })
  end
  detail.apply = res.apply
  return http.ok(detail)
end

local function h_siteEnable(request)
  return setEnabledHandler(request, true)
end

local function h_siteDisable(request)
  return setEnabledHandler(request, false)
end

local function h_siteDelete(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local slug = http.str(body, "slug")
  if type(slug) ~= "string" or util.trim(slug) == "" then
    return http.fail("bad_request", "缺少 slug 参数", { field = "slug" })
  end
  local item, ierr = siteOrFail(slug)
  if not item then return ierr end
  local baseline, baselineErr = optionalStringField(body, "baseline")
  if baselineErr then return baselineErr end
  if item.custom then
    local res, aerr = apply.deleteSiteFile(slug, baseline)
    if not res then return failFrom(aerr) end
    return http.ok({ deleted = true, slug = slug, apply = res.apply })
  end
  if item.orphan then
    -- Never remove metadata while a snippet still exists on disk. A failed
    -- directory scan can make a live file look like an orphan.
    local enabledPath = sites.snippetPath(slug, true)
    local disabledPath = sites.snippetPath(slug, false)
    local _, enabledExists, enabledErr = fs.statChecked(enabledPath)
    if enabledErr then
      return http.fail("internal", "读取站点片段状态失败：" .. tostring(enabledErr), { slug = slug })
    end
    local _, disabledExists, disabledErr = fs.statChecked(disabledPath)
    if disabledErr then
      return http.fail("internal", "读取站点片段状态失败：" .. tostring(disabledErr), { slug = slug })
    end
    if enabledExists or disabledExists then
      return http.fail("conflict", "磁盘上仍存在该站点片段，无法仅清理元数据", {
        slug = slug,
        enabledPath = enabledPath,
        disabledPath = disabledPath,
      })
    end
    local dbOk, dbErr = dbCall(store.deleteSite, slug)
    if not dbOk then
      return http.fail("internal", "删除站点元数据失败：" .. tostring(dbErr), { slug = slug })
    end
    return http.ok({ deleted = true, slug = slug, metadataOnly = true })
  end
  local res, aerr = apply.deleteSiteFile(slug, baseline)
  if not res then return failFrom(aerr) end
  local dbOk, dbErr = dbCall(store.deleteSite, slug)
  if not dbOk then
    return http.fail("internal", "片段已删除但元数据删除失败：" .. tostring(dbErr), {
      slug = slug,
      apply = res.apply,
    })
  end
  return http.ok({ deleted = true, slug = slug, apply = res.apply })
end

-- ---------------------------------------------------------------------------
-- Global configuration
-- ---------------------------------------------------------------------------

local function globalFormFrom(raw)
  local form = { email = "", staging = false, extra = "", admin = "" }
  local parsed = apply.parseGlobal(raw or "")
  if parsed and parsed.hasMarkers then
    form.email = parsed.email or ""
    form.staging = parsed.staging and true or false
    form.extra = parsed.extra or ""
    form.admin = parsed.admin or ""
  end
  return form, parsed
end

local function h_globalGet(request)
  local s = settings.load()
  local raw, exists, readErr = fs.readExisting(s.mainConfig)
  if readErr then
    return http.fail("internal", "读取主 Caddyfile 失败：" .. tostring(readErr), { path = s.mainConfig })
  end
  if not exists then raw = "" end
  local form, parsed = globalFormFrom(raw)
  local hasMarkers = parsed and parsed.hasMarkers or false
  local lastContent = metaGetRaw("global.last_content")
  local drift = hasMarkers and lastContent ~= nil and lastContent ~= raw
  return http.ok({
    exists = exists and true or false,
    raw = raw,
    size = #raw,
    hasMarkers = hasMarkers and true or false,
    form = form,
    drift = drift and true or false,
    lastContent = lastContent,
    path = s.mainConfig,
    backups = backupForGlobal(10),
  })
end

local function globalWrite(request, preview)
  local body, berr = readBody(request)
  if not body then return berr end
  local email = body.email
  if email ~= nil and type(email) ~= "string" then
    return http.fail("invalid_model", "email 必须是字符串", { field = "email" })
  end
  local staging = body.staging
  if staging ~= nil and type(staging) ~= "boolean" then
    return http.fail("invalid_model", "staging 必须是布尔值", { field = "staging" })
  end
  local extra = body.extra
  if extra ~= nil and type(extra) ~= "string" then
    return http.fail("invalid_model", "extra 必须是字符串", { field = "extra" })
  end
  local admin = body.admin
  if admin ~= nil and type(admin) ~= "string" then
    return http.fail("invalid_model", "admin 必须是字符串", { field = "admin" })
  end
  local form = {
    email = email or "",
    staging = staging == true,
    extra = extra or "",
    admin = admin,
  }
  local baseline, baselineErr = optionalStringField(body, "baseline")
  if baselineErr then return baselineErr end
  if preview then
    if baseline == nil then return http.fail("bad_request", "缺少 baseline 参数") end
    local content, err = apply.mergeGlobal(baseline, form)
    if not content then return failFrom(err) end
    return http.ok({ content = content })
  end
  local force, forceErr = optionalBoolField(body, "force", false)
  if forceErr then return forceErr end
  local res, aerr = apply.writeGlobal(form, {
    baseline = baseline,
    force = force,
    reason = "global",
  })
  if not res then return failFrom(aerr) end
  local modelOk = metaSetJson("global.model", res.form)
  local contentOk = metaSetRaw("global.last_content", res.content)
  if not modelOk or not contentOk then
    return http.fail("internal", "全局配置已保存但元数据更新失败", {
      apply = res.apply,
      backup = res.backup,
    })
  end
  return http.ok({
    raw = res.content,
    form = res.form,
    hasMarkers = true,
    apply = res.apply,
    backup = res.backup,
  })
end

local function h_globalSave(request)
  return globalWrite(request, false)
end

local function h_globalPreview(request)
  return globalWrite(request, true)
end

local function h_globalRaw(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local content, contentErr = optionalStringField(body, "content")
  if contentErr then return contentErr end
  if content == nil then
    return http.fail("bad_request", "缺少 content 参数", { field = "content" })
  end
  local baseline, baselineErr = optionalStringField(body, "baseline")
  if baselineErr then return baselineErr end
  local force, forceErr = optionalBoolField(body, "force", false)
  if forceErr then return forceErr end
  local res, aerr = apply.writeMain(content, {
    baseline = baseline,
    force = force,
    reason = "global",
  })
  if not res then return failFrom(aerr) end
  local form, parsed = globalFormFrom(content)
  local hasMarkers = parsed and parsed.hasMarkers or false
  if not metaSetRaw("global.last_content", content) then
    return http.fail("internal", "主 Caddyfile 已保存但元数据更新失败", {
      apply = res.apply,
      backup = res.backup,
    })
  end
  return http.ok({
    raw = content,
    form = form,
    hasMarkers = hasMarkers and true or false,
    apply = res.apply,
    backup = res.backup,
  })
end

local function h_configValidate(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local s = settings.load()
  local content = body.content
  if content ~= nil and type(content) ~= "string" then
    return http.fail("bad_request", "content 必须是字符串", { field = "content" })
  end
  if content == nil then
    local st = fs.stat(s.mainConfig)
    if not st or st.type ~= "file" then
      return http.fail("not_initialized", "主 Caddyfile 不存在，请先在诊断页生成初始配置", {
        mainConfig = s.mainConfig,
      })
    end
    local result = caddy.validateMain(s.mainConfig)
    if not result.ok then
      local e = result.error
      return http.fail("validate_failed", "配置校验失败：" .. caddyMessage(e), {
        output = cap(caddyOutput(e), 8192),
        source = "current",
      })
    end
    return http.ok({ valid = true, source = "current" })
  end
  if #content > fs.LIMIT then
    return http.fail("size_limit", "配置内容超过 48 KiB 限制", { bytes = #content, limit = fs.LIMIT })
  end
  local dir = util.dirname(s.mainConfig)
  if not fs.isDir(dir) then
    return http.fail("not_initialized", "主配置目录不存在，请先在诊断页生成初始配置", { path = dir })
  end
  validateSeq = validateSeq + 1
  local tmp = util.join(dir, ".ecm-validate-" .. tostring(util.nowEpoch()) .. "-" .. tostring(validateSeq) .. ".caddy")
  local wok, werr = fs.writeAtomic(tmp, content, "0644")
  if not wok then
    return http.fail("internal", "写入校验临时文件失败：" .. tostring(werr), { path = tmp })
  end
  local result = caddy.validateMain(tmp)
  fs.remove(tmp)
  if not result.ok then
    local e = result.error
    return http.fail("validate_failed", "配置校验失败：" .. caddyMessage(e), {
      output = cap(caddyOutput(e), 8192),
      source = "candidate",
    })
  end
  return http.ok({ valid = true, source = "candidate" })
end

local function h_configFmt(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local content, contentErr = optionalStringField(body, "content")
  if contentErr then return contentErr end
  if content == nil then
    return http.fail("bad_request", "缺少 content 参数", { field = "content" })
  end
  if #content > fs.LIMIT then
    return http.fail("size_limit", "配置内容超过 48 KiB 限制", { bytes = #content, limit = fs.LIMIT })
  end
  local result = caddy.fmt(content)
  if not (type(result) == "table" and result.ok) then
    local e = type(result) == "table" and result.error or nil
    return http.fail("validate_failed", "格式化失败：" .. caddyMessage(e), {
      output = cap(caddyOutput(e), 8192),
    })
  end
  local formatted = result.formatted
  if type(formatted) ~= "string" then formatted = "" end
  return http.ok({
    formatted = formatted,
    changed = formatted ~= content,
    bytes = #formatted,
  })
end

local function h_hash(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local password = http.str(body, "password")
  if password == nil then
    return http.fail("bad_request", "缺少 password 参数", { field = "password" })
  end
  local result = caddy.hashPassword(password)
  if not (type(result) == "table" and result.ok) then
    return http.fail("hash_failed", "密码哈希失败（请检查密码长度与字符）", nil, 400)
  end
  return http.ok({ hash = result.hash })
end

-- ---------------------------------------------------------------------------
-- Service
-- ---------------------------------------------------------------------------

local function h_service(request)
  return http.ok(serviceView())
end

local function serviceActionHandler(request, action)
  local s = settings.load()
  local fn = services[action]
  if type(fn) ~= "function" then
    return http.fail("internal", "未知的服务操作", { action = action })
  end
  local pok, actionOk, actionErr = pcall(fn, s.serviceUnit)
  if not pok then
    return http.fail("service_error", "服务操作失败：" .. tostring(actionOk))
  end
  if actionOk ~= true then
    return failFrom(actionErr or { code = "service_error", message = "服务操作失败" }, "service")
  end
  return http.ok({ action = action, service = serviceView() })
end

local function h_serviceStart(request) return serviceActionHandler(request, "start") end
local function h_serviceStop(request) return serviceActionHandler(request, "stop") end
local function h_serviceRestart(request) return serviceActionHandler(request, "restart") end

local function h_serviceReload(request)
  local res, aerr = apply.reloadCurrent()
  if not res then return failFrom(aerr, "service") end
  return http.ok({ validate = res.validate, reload = res.reload, service = serviceView() })
end

-- ---------------------------------------------------------------------------
-- Logs
-- ---------------------------------------------------------------------------

local function h_logsService(request)
  local s = settings.load()
  local lines, lerr = queryInt(request, "lines", s.logLines, 100, 2000)
  if lerr then return lerr end
  local q = queryString(request, "q", nil)
  if type(q) ~= "string" then q = nil end
  local incRaw = queryString(request, "includeAccess", nil)
  local includeAccess = truthyQuery(incRaw)
  local pok, res = pcall(logs.serviceEntries, s.serviceUnit, lines, {
    includeAccess = includeAccess,
    q = q,
  })
  if not pok then
    return http.fail("internal", "读取服务日志失败：" .. tostring(res))
  end
  if type(res) ~= "table" then
    return http.fail("internal", "读取服务日志失败")
  end
  if res.error then return failFrom(res.error, "logs") end
  return http.ok({
    unit = s.serviceUnit,
    lines = lines,
    entries = util.array(res.entries or {}),
    includeAccess = includeAccess,
  })
end

local function logModel(item)
  local model = item.model
  if model and not item.orphan and not item.conflict and not item.drift and sites.generate(model) == item.raw then
    return model
  end
end

local function h_logsSite(request)
  local s = settings.load()
  local slug, serr = queryString(request, "slug", nil)
  if serr then return serr end
  if not slug or util.trim(slug) == "" then return http.fail("bad_request", "缺少 slug 参数", { field = "slug" }) end
  local lines, lerr = queryInt(request, "lines", s.logLines, 100, 2000)
  if lerr then return lerr end
  local q, qerr = queryString(request, "q", nil)
  if qerr then return qerr end
  local status, sterr = queryInt(request, "status", nil, 100, 599)
  if sterr then return sterr end
  local statusClass, cerr = queryInt(request, "statusClass", nil, 4, 5)
  if cerr then return cerr end
  local item, ierr = siteOrFail(slug)
  if not item then return ierr end
  local model = logModel(item)
  local ports = model and not model.access and apply.httpPorts(fs.read(s.mainConfig)) or nil
  local result = logs.siteEntries(s.serviceUnit, model, lines, {
    q = q, status = status, statusClass = statusClass, ports = ports,
  })
  result.slug = slug
  result.domains = util.array(item.domains or {})
  result.lines = lines
  return http.ok(result)
end

local function h_siteCheck(request)
  local body, err = readBody(request)
  if not body then return err end
  local item, ierr = siteOrFail(body.slug)
  if not item then return ierr end
  local index = body.index or 1
  if type(index) ~= "number" or index % 1 ~= 0 or index < 1 or index > math.max(1, #item.domains) then
    return http.fail("bad_request", "请选择一个已配置的站点入口", { field = "index" })
  end
  return http.ok(sitecheck.run(settings.load(), item, index))
end

local function compactTimestamp()
  return (string.gsub(util.nowUTC(), "[-:]", ""))
end

local function h_logsExport(request)
  local s = settings.load()
  local scope = queryString(request, "scope", nil)
  if scope == nil or scope == "" then scope = "service" end
  if scope ~= "service" and scope ~= "site" then
    return http.fail("bad_request", "scope 必须为 service 或 site", { field = "scope" })
  end
  local lines, lerr = queryInt(request, "lines", s.logLines, 1, 2000)
  if lerr then return lerr end
  local text, err
  local slug = nil
  if scope == "service" then
    local pok
    pok, text, err = pcall(logs.exportText, s.serviceUnit, "service", {}, lines, {})
    if not pok then
      return http.fail("internal", "导出日志失败：" .. tostring(text))
    end
  else
    slug = queryString(request, "slug", nil)
    if type(slug) ~= "string" or util.trim(slug) == "" then
      return http.fail("bad_request", "缺少 slug 参数", { field = "slug" })
    end
    local item, ierr = siteOrFail(slug)
    if not item then return ierr end
    local model = logModel(item)
    local ports = model and not model.access and apply.httpPorts(fs.read(s.mainConfig)) or nil
    local pok
    pok, text, err = pcall(logs.exportText, s.serviceUnit, "site", model, lines, { ports = ports })
    if not pok then
      return http.fail("internal", "导出日志失败：" .. tostring(text))
    end
  end
  if text == nil then
    return failFrom(err or { code = "internal", message = "导出日志失败" }, "logs")
  end
  local ts = compactTimestamp()
  local filename
  if scope == "service" then
    filename = "caddy-service-" .. ts .. ".log"
  else
    filename = "caddy-site-" .. tostring(slug) .. "-" .. ts .. ".log"
  end
  local headers = {
    ["content-type"] = "text/plain; charset=utf-8",
    ["cache-control"] = "no-store",
    ["content-disposition"] = 'attachment; filename="' .. filename .. '"',
  }
  return http.text(text, headers)
end

-- ---------------------------------------------------------------------------
-- Certificates
-- ---------------------------------------------------------------------------

local function savedEntry(request, internalOnly)
  local slug = queryString(request, "slug", nil)
  if not slug then return nil, http.fail("bad_request", "缺少 slug 参数") end
  local item, err = siteOrFail(slug)
  if not item then return nil, err end
  local model = item.model
  if not model or not model.access or (internalOnly and model.access.protocol ~= "internal") then
    return nil, http.fail("bad_request", "站点没有所需的访问入口")
  end
  if not item.enabled or item.conflict or item.drift or sites.generate(model) ~= item.raw then
    return nil, http.fail("conflict", "请先保存并启用站点入口")
  end
  return model
end

local function h_entryCheck(request)
  local model, err = savedEntry(request, false)
  if not model then return err end
  local index, queryErr = queryInt(request, "index", 1, 1, #model.domains)
  if queryErr then return queryErr end
  return http.ok(certs.checkEntry(model, index, truthyQuery(request.query.get)))
end

local function h_rootCA(request)
  local model, err = savedEntry(request, true)
  if not model then return err end
  local ca = certs.rootCA(apply.adminAddress(settings.load()))
  if not ca then
    return http.fail("service_error", "无法读取运行实例的根 CA。请确认 Caddy 已加载内网 HTTPS，并可通过本机 Admin API 访问。")
  end
  return http.ok(ca)
end

local function h_certs(request)
  local data = sites.loadAll()
  local now = util.nowEpoch()
  return http.ok({
    items = certListFor(data, now),
    checkedAt = util.nowUTC(),
  })
end

local function h_certsRefresh(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local force = http.bool(body, "force", false)
  local data = sites.loadAll()
  local now = util.nowEpoch()
  local pok, res = pcall(certs.refresh, sitesArg(data), { force = force, now = now })
  if not pok then
    return http.fail("internal", "证书探测失败：" .. tostring(res))
  end
  local refreshed, errors = 0, 0
  if type(res) == "table" then
    if type(res.refreshed) == "number" then refreshed = res.refreshed end
    if type(res.errors) == "number" then errors = res.errors end
  end
  return http.ok({
    refreshed = refreshed,
    errors = errors,
    items = certListFor(data, util.nowEpoch()),
  })
end

-- ---------------------------------------------------------------------------
-- Backups
-- ---------------------------------------------------------------------------

local function h_backups(request)
  local scope = queryString(request, "scope", nil)
  if scope ~= nil and scope ~= "" and scope ~= "global" and scope ~= "site" then
    return http.fail("bad_request", "scope 必须为 global 或 site", { field = "scope" })
  end
  local limit, lerr = queryInt(request, "limit", 100, 1, 1000)
  if lerr then return lerr end
  local all = fs.listBackups() or {}
  local items = util.array({})
  local total = 0
  for _, entry in ipairs(all) do
    if scope == nil or scope == "" or entry.scope == scope then
      total = total + 1
      if #items < limit then items[#items + 1] = entry end
    end
  end
  return http.ok({ items = items, total = total })
end

local function h_backup(request)
  local name = queryString(request, "name", nil)
  if type(name) ~= "string" or name == "" then
    return http.fail("bad_request", "缺少 name 参数", { field = "name" })
  end
  if not util.safeBackupName(name) then
    return http.fail("bad_request", "备份名称不合法", { name = name })
  end
  local content, info, rerr = fs.readBackup(name)
  if content == nil then
    return http.fail("not_found", "备份不存在或无法读取", {
      name = name,
      error = cap(tostring(info or rerr)),
    })
  end
  if type(info) ~= "table" then info = {} end
  return http.ok({
    name = name,
    content = content,
    size = info.size or #content,
    mtime = info.mtime or 0,
    reason = info.reason or "",
    target = info.target or "",
    scope = info.scope or "",
  })
end

local function h_backupRestore(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local name = http.str(body, "name")
  if type(name) ~= "string" or name == "" then
    return http.fail("bad_request", "缺少 name 参数", { field = "name" })
  end
  local baseline, baselineErr = optionalStringField(body, "baseline")
  if baselineErr then return baselineErr end
  local res, aerr = apply.restoreBackup(name, baseline)
  if not res then return failFrom(aerr, "backup") end
  if res.scope == "global" then
    local s = settings.load()
    local raw, exists, readErr = fs.readExisting(s.mainConfig)
    if readErr or not exists then
      return http.fail("internal", "备份已恢复但读取主 Caddyfile 失败", {
        apply = res.apply,
        error = tostring(readErr or "文件不存在"),
      })
    end
    if not metaSetRaw("global.last_content", raw) then
      return http.fail("internal", "备份已恢复但元数据更新失败", { apply = res.apply })
    end
  elseif res.scope == "site" and type(res.slug) == "string" then
    local pok, row, rowErr = pcall(store.getSite, res.slug)
    if not pok then
      return http.fail("internal", "备份已恢复但读取站点元数据失败：" .. tostring(row), {
        apply = res.apply,
        slug = res.slug,
      })
    end
    if rowErr ~= nil then
      return http.fail("internal", "备份已恢复但读取站点元数据失败：" .. tostring(rowErr), {
        apply = res.apply,
        slug = res.slug,
      })
    end
    if type(row) == "table" then
      local content, contentExists, contentErr = fs.readExisting(sites.snippetPath(res.slug, res.enabled))
      if contentErr or not contentExists then
        return http.fail("internal", "备份已恢复但读取站点片段失败", {
          apply = res.apply,
          slug = res.slug,
          error = tostring(contentErr or "文件不存在"),
        })
      end
      local dbOk, dbErr = dbCall(store.updateSiteContent, res.slug, row.model or "{}", content, res.enabled, util.nowUTC())
      if not dbOk then
        return http.fail("internal", "备份已恢复但元数据更新失败：" .. tostring(dbErr), {
          apply = res.apply,
          slug = res.slug,
        })
      end
    end
  end
  return http.ok(res)
end

-- ---------------------------------------------------------------------------
-- Diagnostics
-- ---------------------------------------------------------------------------

local function diagItem(key, label, status, message, details)
  return {
    key = key,
    label = label,
    status = status,
    message = cap(message or "", 2000),
    details = details or {},
  }
end

local DNS_PROVIDERS = { "dns.providers.cloudflare", "dns.providers.alidns", "dns.providers.tencentcloud" }

local function runningBuild(path, service)
  local pid = type(service) == "table" and tonumber(service.mainPid)
  if not pid or pid < 1 or pid % 1 ~= 0 then return "unknown" end
  local ok, result = pcall(host.process.exec, "cmp", {
    "-s", "--", path, "/proc/" .. pid .. "/exe",
  }, { timeoutMs = 4000 })
  if not ok or not result or result.timedOut or result.error then return "unknown" end
  if result.exitCode == 0 then return "same" end
  if result.exitCode == 1 then return "different" end
  return "unknown"
end

local function dnsCapacity(modules, service, path)
  local available, ids = {}, util.array({})
  for _, id in ipairs(modules.items or {}) do
    if id:match("^dns%.providers%.[%w_.%-]+$") then available[id] = true end
  end
  local listed = {}
  for _, id in ipairs(DNS_PROVIDERS) do
    ids[#ids + 1], listed[id] = id, true
  end
  local extras = {}
  for id in pairs(available) do
    if not listed[id] then extras[#extras + 1] = id end
  end
  table.sort(extras)
  for _, id in ipairs(extras) do ids[#ids + 1] = id end

  local runtime = runningBuild(path, service)
  local providers = util.array({})
  for _, id in ipairs(ids) do
    local status = available[id] and "installed" or modules.ok and not modules.truncated and "missing" or "unknown"
    providers[#providers + 1] = { id = id, disk = status, running = runtime == "same" and status or "unknown" }
  end
  return { runningBuild = runtime, providers = providers }
end

local function diagnosticsData()
  local s = settings.load()
  local items = util.array({})
  local summary = { ok = 0, warn = 0, error = 0, unknown = 0 }
  local function add(item)
    items[#items + 1] = item
    summary[item.status] = (summary[item.status] or 0) + 1
  end

  if #s.warnings > 0 then
    add(diagItem("config", "插件配置", "warn", table.concat(s.warnings, "；"), {
      warnings = s.warnings,
    }))
  else
    add(diagItem("config", "插件配置", "ok", "配置值有效"))
  end

  local caddyField = { ok = false }
  local versionRes = nil
  local caddyStat = fs.stat(s.caddyBinary)
  if not caddyStat or caddyStat.type ~= "file" then
    add(diagItem("binary", "Caddy 可执行文件", "error",
      "未找到 Caddy 可执行文件：" .. s.caddyBinary,
      { path = s.caddyBinary, code = "caddy_missing" }))
  else
    versionRes = caddy.version()
    if type(versionRes) == "table" and versionRes.ok then
      add(diagItem("binary", "Caddy 可执行文件", "ok", "可执行", { path = s.caddyBinary }))
      caddyField.ok = true
      caddyField.version = versionRes.version or ""
      caddyField.raw = versionRes.raw
    else
      local e = type(versionRes) == "table" and versionRes.error or nil
      add(diagItem("binary", "Caddy 可执行文件", "error",
        "无法执行 Caddy：" .. caddyMessage(e),
        { path = s.caddyBinary, code = "caddy_missing" }))
      caddyField.message = caddyMessage(e)
    end
  end
  if versionRes == nil then
    add(diagItem("version", "Caddy 版本", "unknown", "未检测到 Caddy 可执行文件"))
  elseif type(versionRes) == "table" and versionRes.ok then
    add(diagItem("version", "Caddy 版本", "ok", versionRes.version or "",
      { version = versionRes.version or "", truncated = versionRes.truncated and true or false }))
  else
    local e = type(versionRes) == "table" and versionRes.error or nil
    add(diagItem("version", "Caddy 版本", "unknown", "无法读取版本：" .. caddyMessage(e)))
  end

  local mainStat = fs.stat(s.mainConfig)
  local initialized = mainStat ~= nil and mainStat.type == "file"
  local mainRaw = nil
  if not mainStat then
    add(diagItem("main", "主 Caddyfile", "warn", "尚未初始化", { path = s.mainConfig }))
  elseif mainStat.type ~= "file" then
    add(diagItem("main", "主 Caddyfile", "error", "路径不是普通文件", { path = s.mainConfig }))
  else
    mainRaw = fs.read(s.mainConfig)
    if mainRaw == nil then
      add(diagItem("main", "主 Caddyfile", "error", "文件无法读取", { path = s.mainConfig }))
    else
      local writable = fs.writable(util.dirname(s.mainConfig))
      local details = { path = s.mainConfig, size = mainStat.size, mtime = mainStat.mtime }
      if writable then
        add(diagItem("main", "主 Caddyfile", "ok", "文件可读写", details))
      else
        add(diagItem("main", "主 Caddyfile", "warn", "文件可读但所在目录不可写", details))
      end
    end
  end

  local hasMarkers = false
  if mainRaw ~= nil then
    local parsed = apply.parseGlobal(mainRaw)
    hasMarkers = parsed and parsed.hasMarkers or false
  end
  if hasMarkers then
    add(diagItem("markers", "全局受管标记", "ok", "受管全局块标记完整"))
  elseif initialized then
    add(diagItem("markers", "全局受管标记", "warn", "缺少受管全局块标记",
      { mainConfig = s.mainConfig }))
  else
    add(diagItem("markers", "全局受管标记", "warn", "尚未初始化"))
  end
  if initialized and mainRaw ~= nil then
    if apply.hasSnippetImport(mainRaw, s) then
      add(diagItem("import", "站点片段导入", "ok", "主 Caddyfile 已导入片段目录",
        { snippetDir = s.snippetDir }))
    else
      add(diagItem("import", "站点片段导入", "error",
        "主 Caddyfile 未导入站点片段目录，站点不会生效", {
          snippetDir = s.snippetDir,
          hint = "在全局配置原文中添加 import <片段目录>/*.caddy，或在诊断页生成初始配置",
        }))
    end
  else
    add(diagItem("import", "站点片段导入", "warn", "尚未初始化，无法检查 import"))
  end

  local function dirCheck(key, label, path, missingStatus, missingMessage)
    local st = fs.stat(path)
    if not st then
      add(diagItem(key, label, missingStatus, missingMessage, { path = path, exists = false }))
      return
    end
    if st.type ~= "directory" then
      add(diagItem(key, label, "error", "路径不是目录", { path = path, exists = true }))
      return
    end
    local writable, werr = fs.writable(path)
    if writable then
      add(diagItem(key, label, "ok", "目录存在且可写", { path = path }))
    else
      add(diagItem(key, label, "warn", "目录不可写：" .. tostring(werr), { path = path }))
    end
  end
  dirCheck("snippetDir", "站点片段目录", s.snippetDir, "warn", "目录不存在，保存时将自动创建")
  dirCheck("disabledDir", "停用片段目录", s.disabledDir, "warn", "目录不存在，保存时将自动创建")
  dirCheck("sitesRoot", "站点根目录", s.sitesRoot, "warn", "目录不存在，新建站点前请创建")

  local upok, unitDetail, unitErr = pcall(services.get, s.serviceUnit)
  if not upok then
    unitErr = { code = "service_error", message = tostring(unitDetail) }
    unitDetail = nil
  end
  if unitDetail then
    add(diagItem("unit", "systemd 单元", "ok", "状态：" .. tostring(unitDetail.state or "unknown"), {
      unit = s.serviceUnit,
      state = unitDetail.state,
      stateDetail = unitDetail.stateDetail,
      bootState = unitDetail.bootState,
      fragmentPath = unitDetail.fragmentPath,
    }))
  else
    local code = type(unitErr) == "table" and unitErr.code or "service_error"
    local message = type(unitErr) == "table" and unitErr.message or "无法读取服务状态"
    local status = "error"
    if code == "not_found" or code == "privilege_missing" then
      status = "warn"
    end
    add(diagItem("unit", "systemd 单元", status, message, { unit = s.serviceUnit, code = code }))
  end

  local lpok, logLines, logErr = pcall(services.logs, s.serviceUnit, 10)
  if lpok and logLines ~= nil then
    add(diagItem("journal", "journald 日志", "ok", "可读取日志", { lines = #logLines }))
  else
    local code = type(logErr) == "table" and logErr.code or "journal_unavailable"
    local message = type(logErr) == "table" and logErr.message or "无法读取 journald 日志"
    if not lpok then message = tostring(logLines) end
    add(diagItem("journal", "journald 日志", "warn", message, {
      code = code,
    }))
  end

  add(diagItem("sudo", "服务提权", "unknown", "由系统 sudoers 决定，通过启动、停止或重启的结果确认"))

  local modulesField = {
    items = util.array({}),
    truncated = false,
    optional = { l4 = false, ratelimit = false, dns = false },
  }
  local modulesRes = caddy.modules()
  if type(modulesRes) == "table" and modulesRes.ok then
    local list = modulesRes.items or {}
    modulesField.ok = true
    modulesField.items = util.array(list)
    modulesField.truncated = modulesRes.truncated and true or false
    local l4, ratelimit, dns = false, false, false
    for _, name in ipairs(list) do
      local lowered = util.lower(tostring(name))
      if string.find(lowered, "layer4", 1, true) or string.find(lowered, "caddy-l4", 1, true) then
        l4 = true
      end
      if string.find(lowered, "ratelimit", 1, true) then ratelimit = true end
      -- Only DNS-01 provider modules count; tls.ech.publishers.dns is unrelated.
      if string.find(lowered, "dns.providers.", 1, true) then dns = true end
    end
    modulesField.optional = { l4 = l4, ratelimit = ratelimit, dns = dns }
    add(diagItem("modules", "Caddy 模块",
      modulesField.truncated and "warn" or "ok",
      "检测到 " .. tostring(#list) .. " 个模块", {
        count = #list,
        truncated = modulesField.truncated,
        optional = modulesField.optional,
      }))
  else
    local e = type(modulesRes) == "table" and modulesRes.error or nil
    add(diagItem("modules", "Caddy 模块", "unknown", "无法列出模块：" .. caddyMessage(e)))
  end

  local validateField = { ok = false, message = "尚未初始化" }
  if initialized and mainRaw ~= nil then
    local result = caddy.validateMain(s.mainConfig)
    if result.ok then
      validateField = { ok = true, message = "配置有效" }
      add(diagItem("validate", "整体配置校验", "ok", "配置有效"))
    else
      local e = result.error
      validateField = { ok = false, message = caddyMessage(e) }
      add(diagItem("validate", "整体配置校验", "error", validateField.message, {
        output = cap(caddyOutput(e), 8192),
      }))
    end
  else
    add(diagItem("validate", "整体配置校验", "warn", "尚未初始化，无法校验"))
  end

  return {
    items = items,
    summary = summary,
    initialized = initialized and true or false,
    hasMarkers = hasMarkers and true or false,
    paths = {
      caddyBinary = s.caddyBinary,
      mainConfig = s.mainConfig,
      snippetDir = s.snippetDir,
      disabledDir = s.disabledDir,
      sitesRoot = s.sitesRoot,
      backupsDir = s.backupsDir,
    },
    config = util.array(settings.effective()),
    caddy = caddyField,
    modules = modulesField,
    dns = dnsCapacity(modulesField, unitDetail, s.caddyBinary),
    validate = validateField,
  }
end

local function h_diagnostics(request)
  return http.ok(diagnosticsData())
end

local function h_diagnosticsInit(request)
  local body, berr = readBody(request)
  if not body then return berr end
  local overwrite = http.bool(body, "overwrite", false)
  local res, aerr = apply.init(overwrite)
  if not res then return failFrom(aerr, "diagnostics") end
  return http.ok({
    written = res.written,
    mainConfig = res.mainConfig,
    createdDirs = res.createdDirs,
    diagnostics = diagnosticsData(),
  })
end

-- ---------------------------------------------------------------------------
-- Route table
-- ---------------------------------------------------------------------------

M.routes = util.array({
  { method = "GET", path = "/local-listeners", handler = h_localListeners },
  { method = "POST", path = "/local-listeners/probe", handler = h_probeListener },
  { method = "GET", path = "/health", handler = h_health },
  { method = "GET", path = "/overview", handler = h_overview },
  { method = "GET", path = "/sites", handler = h_sites },
  { method = "GET", path = "/site", handler = h_site },
  { method = "POST", path = "/site", handler = h_siteCreate },
  { method = "POST", path = "/site/update", handler = h_siteUpdate },
  { method = "POST", path = "/site/preview", handler = h_sitePreview },
  { method = "POST", path = "/site/raw", handler = h_siteRaw },
  { method = "POST", path = "/site/validate", handler = h_siteValidate },
  { method = "POST", path = "/site/enable", handler = h_siteEnable },
  { method = "POST", path = "/site/disable", handler = h_siteDisable },
  { method = "POST", path = "/site/delete", handler = h_siteDelete },
  { method = "GET", path = "/global", handler = h_globalGet },
  { method = "POST", path = "/global", handler = h_globalSave },
  { method = "POST", path = "/global/preview", handler = h_globalPreview },
  { method = "POST", path = "/global/raw", handler = h_globalRaw },
  { method = "POST", path = "/config/validate", handler = h_configValidate },
  { method = "POST", path = "/config/fmt", handler = h_configFmt },
  { method = "POST", path = "/hash", handler = h_hash },
  { method = "GET", path = "/service", handler = h_service },
  { method = "POST", path = "/service/start", handler = h_serviceStart },
  { method = "POST", path = "/service/stop", handler = h_serviceStop },
  { method = "POST", path = "/service/restart", handler = h_serviceRestart },
  { method = "POST", path = "/service/reload", handler = h_serviceReload },
  { method = "GET", path = "/logs/service", handler = h_logsService },
  { method = "GET", path = "/logs/site", handler = h_logsSite },
  { method = "GET", path = "/logs/export", handler = h_logsExport },
  { method = "GET", path = "/site/entry-check", handler = h_entryCheck },
  { method = "POST", path = "/site/check", handler = h_siteCheck },
  { method = "GET", path = "/metrics", handler = function() return http.ok(metrics.get(settings.load(), false)) end },
  { method = "POST", path = "/metrics", handler = function() return http.ok(metrics.get(settings.load(), true)) end },
  { method = "GET", path = "/site/root-ca", handler = h_rootCA },
  { method = "GET", path = "/certs", handler = h_certs },
  { method = "POST", path = "/certs/refresh", handler = h_certsRefresh },
  { method = "GET", path = "/backups", handler = h_backups },
  { method = "GET", path = "/backup", handler = h_backup },
  { method = "POST", path = "/backup/restore", handler = h_backupRestore },
  { method = "GET", path = "/diagnostics", handler = h_diagnostics },
  { method = "POST", path = "/diagnostics/init", handler = h_diagnosticsInit },
})

return M
