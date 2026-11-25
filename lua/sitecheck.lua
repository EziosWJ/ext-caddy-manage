-- Checks run from the Host. Ingress is pinned locally after checking DNS
-- separately, so an unresolved or external name never redirects the probe.
local apply = require("apply")
local caddy = require("caddy")
local certs = require("certs")
local discovery = require("discovery")
local fs = require("fs")
local sites = require("sites")
local util = require("util")

local M = {}
local UPSTREAM_LIMIT = 3

local function exec(program, args, timeout)
  local ok, result = pcall(host.process.exec, program, args, { timeoutMs = timeout })
  if ok then return result end
end

local function output(result)
  if not result then return nil end
  return util.trim((result.stderr or "") .. "\n" .. (result.stdout or "")):sub(1, 1200)
end

local function checkDNS(name, add)
  if sites.canonicalIP(name) then
    add("dns", "skipped", "入口使用 IP，无需解析。")
    return
  end
  local result = exec("getent", { "ahosts", "--", name }, 1250)
  if not result then
    add("dns", "unknown", "宿主无法运行 getent。请在宿主确认名称解析。")
  elseif result.exitCode == 0 and result.stdout ~= "" and not result.timedOut then
    add("dns", "ok", "宿主可解析此名称。后续入口探测连接本机监听地址。", output(result))
  else
    add("dns", "error", result.timedOut and "宿主解析超时。请检查宿主解析器。"
      or "宿主无法解析此名称。请检查 DNS 或宿主 hosts 记录。", output(result))
  end
end

local function checkListen(config, entry, add)
  local status, evidence = discovery.checkListener(config, entry.address, entry.port)
  if status == "caddy" then
    add("listen", "ok", entry.target .. " 的 TCP 监听归属 Caddy。", evidence)
  elseif status == "conflict" then
    add("listen", "error", entry.target .. " 由其他进程监听。请核对进程或更换入口端口。", evidence, "site")
  elseif status == "missing" then
    add("listen", "error", entry.target .. " 没有匹配的 TCP 监听。请检查绑定地址及配置是否已重载。", nil, "site")
  else
    add("listen", "unknown", "无法确认端口归属。请检查 ss 和宿主读取进程的权限。", evidence)
  end
  return status == "missing" or status == "conflict"
end

local function checkUpstreams(model, add)
  local targets, seen = {}, {}
  for _, pool in ipairs(discovery.proxyPools(model)) do
    for _, upstream in ipairs(pool.proxy.upstreams) do
      if not seen[upstream] then
        seen[upstream] = true
        targets[#targets + 1] = { address = upstream, proxy = pool.proxy }
      end
    end
  end
  if #targets == 0 then
    add("upstream", "skipped", "本站没有代理上游。")
    return
  end
  local failures, unknown, evidence = 0, 0, {}
  for i = 1, math.min(#targets, UPSTREAM_LIMIT) do
    local target = targets[i]
    local url = target.address:find("://", 1, true) and target.address or "http://" .. target.address
    local args = { "-q", "--head", "--silent", "--show-error", "--noproxy", "*", "--globoff",
      "--proto", "=http,https", "--connect-timeout", "1", "--max-time", "1",
      "--output", "/dev/null", "--write-out", "%{http_code}" }
    if target.proxy.hostHeader and target.proxy.hostHeader ~= "" then
      args[#args + 1] = "--header"
      args[#args + 1] = "Host: " .. target.proxy.hostHeader
    end
    if target.proxy.skipVerify then args[#args + 1] = "--insecure" end
    args[#args + 1] = "--"
    args[#args + 1] = url .. "/"
    local response = exec("curl", args, 1250)
    local status = response and response.exitCode == 0 and tonumber(response.stdout)
    local reason
    if not response then
      reason, unknown = "无法执行 curl", unknown + 1
    elseif status and status >= 100 and status <= 599 then
      reason = "HTTP " .. status
    else
      failures = failures + 1
      reason = (response.timedOut or response.exitCode == 28) and "响应超时" or "连接或握手失败"
    end
    local detail = output(response)
    evidence[#evidence + 1] = target.address .. " · " .. reason
      .. (not status and detail and detail ~= "" and "\n" .. detail:sub(1, 220) or "")
  end
  local tested = math.min(#targets, UPSTREAM_LIMIT)
  local coverage = string.format("已检查 %d / %d 个配置目标的 HEAD /。", tested, #targets)
  local details = table.concat(evidence, "\n")
  if failures > 0 then
    local nextStep = "请核对上游进程、地址和协议。"
    local messages = {}
    for _, line in ipairs(evidence) do messages[#messages + 1] = line:match("^[^\n]+") end
    add("upstream", "error", coverage .. table.concat(messages, "；") .. "。" .. nextStep, details, "site")
  elseif unknown > 0 or tested < #targets then
    add("upstream", "unknown", coverage .. "上游连通性只得到部分验证。", details, "site")
  else
    add("upstream", "ok", coverage .. "上游均返回 HTTP，连通性已验证。", details)
  end
end

local function getTarget(model, index, main)
  if model.access then return certs.entryTarget(model, index) end
  local name = model.domains[index]
  local port = name:match(":(%d+)$")
  local protocol = (port or model.https == false) and "http" or "auto"
  local wildcard = name:match("^0%.0%.0%.0:") ~= nil
  local ports = apply.httpPorts(main)
  return certs.entryTarget({
    domains = { wildcard and "127.0.0.1" or name:gsub(":%d+$", "") },
    access = { protocol = protocol, port = tonumber(port) or (protocol == "http" and ports.http or ports.https) },
  }, 1)
end

local stages = { "dns", "listen", "tls", "upstream", "http" }

function M.run(config, item, index)
  local result = { slug = item.slug, perspective = "host", checkedAt = util.nowUTC(), steps = util.array({}) }
  local function add(id, status, message, raw, action)
    result.steps[#result.steps + 1] = { id = id, status = status, message = message, output = raw, action = action }
    if status == "error" and not result.firstFailure then result.firstFailure = id end
  end
  local main = fs.read(config.mainConfig)
  local validation = main and caddy.validateMain(config.mainConfig, 3000)
  local configStatus, configMessage, raw, action = "ok", "当前磁盘主配置和导入片段校验通过。"
  if not main then
    configStatus, configMessage, action = "error", "主配置不可读。请检查路径和权限。", "global"
  elseif not validation.ok then
    local err = validation.error or {}
    local details = err.details or {}
    raw = (details.stderr or details.stdout or err.message or ""):sub(1, 2000)
    configStatus, configMessage, action = "error",
      err.code == "timeout" and "磁盘配置校验超过 3 秒。请在全局配置单独校验。"
      or "当前磁盘配置校验失败。请检查主配置和导入的片段。", "global"
  elseif item.conflict or item.orphan or not item.enabled then
    configStatus, configMessage, action = "error", "站点未启用、片段缺失或存在同名冲突。请核对站点片段。", "site"
  elseif not item.model or sites.generate(item.model) ~= item.raw then
    configStatus, configMessage, action = "unknown", "片段为手写配置或已偏离表单。请从配置原文核对入口和上游。", "site"
  elseif not apply.hasSnippetImport(main, config) then
    configStatus, configMessage, action = "unknown", "未识别到受管片段目录的 import。请确认主配置已导入本站。", "global"
  end
  if configStatus ~= "ok" then
    for _, id in ipairs(stages) do add(id, "skipped", "请先确认配置。") end
    add("config", configStatus, configMessage, raw, action)
    return result
  end

  local entry = getTarget(item.model, index, main)
  result.target, result.url = entry.target, entry.url
  checkDNS(entry.name, add)
  local blocked = checkListen(config, entry, add)
  local tls = {}
  if entry.protocol == "http" then
    add("tls", "skipped", "入口仅使用 HTTP。")
  elseif blocked then
    add("tls", "skipped", "请先恢复 Caddy 监听。")
  else
    certs.checkTLS(entry, tls, false, 1750)
    if tls.trust == "trusted" then
      add("tls", "ok", "TLS 握手、证书身份和宿主信任通过。")
    elseif tls.trust == "untrusted" then
      local nameMismatch = tls.verifyCode == 62 or tls.verifyCode == 64
      local message = nameMismatch and "证书身份与入口不匹配。请核对域名、IP 或 SNI。"
        or "证书未通过宿主信任校验。请核对证书链、有效期和根 CA。"
      add("tls", "error", message, "OpenSSL verify code " .. tls.verifyCode, "tls")
    else
      add("tls", "error", tls.error or "宿主无法确认 TLS 信任。请检查证书和签发状态。", tls.output, "tls")
    end
  end
  checkUpstreams(item.model, add)
  if blocked or (entry.protocol ~= "http" and tls.trust ~= "trusted") then
    add("http", "skipped", "请先恢复入口监听和 TLS。")
  else
    certs.checkHTTP(entry, tls, false, 2000)
    local status = tls.httpStatus
    if not status then
      add("http", "error", "本机 HEAD / 未收到响应。请检查入口及代理配置。", tls.output, "site")
    elseif status >= 400 then
      add("http", "error", "本机 HEAD / 返回 HTTP " .. status .. "。请核对访问限制、根路径和代理响应。", nil, "site")
    else
      add("http", "ok", "本机 HEAD / 返回 HTTP " .. status .. "。")
    end
  end
  add("config", configStatus, configMessage)
  return result
end

return M
