-- On-demand Linux TCP discovery. Only endpoints from the current listener
-- snapshot can be probed, and socket identity is checked again before publish.
local util = require("util")
local sites = require("sites")
local apply = require("apply")

local M = {}

local function exec(program, args, timeout)
  local ok, result = pcall(host.process.exec, program, args, { timeoutMs = timeout })
  if ok then return result end
end

local function authority(hostname, port)
  return (hostname:find(":", 1, true) and ("[" .. hostname .. "]") or hostname) .. ":" .. port
end

local function unpackAddress(value)
  local hostname, port = value:match("^(.*):(%d+)$")
  if not port then return nil end
  hostname = hostname:gsub("^%[(.*)%]$", "%1"):lower()
  return sites.canonicalIP(hostname) or hostname, tonumber(port)
end

local function readSmall(path, size)
  local file = io.open(path, "rb")
  if not file then return nil end
  local value = file:read(size)
  file:close()
  return value
end

local function managementPorts(settings)
  local ports = { [2019] = true }
  local configured = apply.adminAddress(settings) or ""
  local _, caddyPort = unpackAddress(configured:gsub("%s.*$", ""))
  if caddyPort then ports[caddyPort] = true end

  -- Standalone Host uses --listen; the Lua request does not carry the
  -- server's local address. The socket owner also covers embedded Hosts.
  local command = readSmall("/proc/self/cmdline", 4096) or ""
  local executable = command:match("^([^%z]*)")
  local previous, hostPort
  for arg in command:gmatch("[^%z]+") do
    local address = arg:match("^%-%-?listen=(.+)$")
    if previous == "--listen" or previous == "-listen" then address = arg end
    if address then
      local _, port = unpackAddress(address)
      hostPort = port
    end
    previous = arg
  end
  if not hostPort and util.basename(executable) == "ext" then hostPort = 5001 end
  if hostPort then ports[hostPort] = true end
  return ports
end

local function serviceUnit(path)
  return path and path:match("/([%w_.@:%-]+%.service)$") or nil
end

local function unitFor(pid)
  if not pid then return nil end
  local group = readSmall("/proc/" .. pid .. "/cgroup", 4096) or ""
  for _, line in ipairs(util.splitLines(group)) do
    local unit = serviceUnit(line)
    if unit then return unit end
  end
end

local function ownerOf(extra, selfPid, settings)
  local name, pid, unit
  local socketUnit = serviceUnit(extra:match("cgroup:(%S+)"))
  if socketUnit == settings.serviceUnit or socketUnit == "caddy.service" then return true end
  local caddy = util.basename(settings.caddyBinary):sub(1, 15)
  for process, id in extra:gmatch('%("([^"]+)",pid=(%d+)') do
    local service = socketUnit or unitFor(id)
    if id == selfPid or process == "ext" or process == "caddy" or process == caddy
      or service == settings.serviceUnit then
      return true
    end
    if not name then name, pid, unit = process, tonumber(id), service end
  end
  return false, name, pid, unit or socketUnit
end

local function listenOutput(port)
  local args = { "-H", "-ltnpe" }
  if port then args[#args + 1] = "sport = :" .. port end
  local result = exec("ss", args, 1500)
  if not result or result.exitCode ~= 0 or result.timedOut or result.stdoutTruncated then return nil end
  return result.stdout
end

local function listenerLine(line)
  return line:match("^%s*LISTEN%s+%S+%s+%S+%s+(%S+)%s+%S+%s*(.*)")
end

function M.checkListener(config, address, port)
  local output = listenOutput(port)
  if not output then return "unavailable" end
  local states, evidence = {}, {}
  local ipv6 = address:find(":", 1, true) ~= nil
  local caddy = util.basename(config.caddyBinary):sub(1, 15)
  for _, line in ipairs(util.splitLines(output)) do
    local bound, extra = listenerLine(line)
    local ip, number
    if bound then ip, number = unpackAddress(bound) end
    if number == port and (ip == address or (ip == "0.0.0.0" and not ipv6)
      or (ip == "::" and (ipv6 or not extra:find("v6only:1", 1, true)))
      or (ip == "*" and (ipv6 or not extra:find("v6only:1", 1, true)))) then
      local unit = serviceUnit(extra:match("cgroup:(%S+)"))
      local state = unit == config.serviceUnit and "caddy" or "unknown"
      for process, pid in extra:gmatch('%("([^"]+)",pid=(%d+)') do
        local owner = unit or unitFor(pid)
        if owner == config.serviceUnit or process == caddy then
          state = "caddy"
        elseif state ~= "caddy" then
          state = "conflict"
        end
      end
      states[state] = true
      evidence[#evidence + 1] = line
    end
  end
  local state = states.conflict and "conflict" or states.unknown and "unknown"
    or states.caddy and "caddy" or "missing"
  return state, table.concat(evidence, "\n"):sub(1, 1500)
end

local function snapshot(settings)
  local output = listenOutput()
  if not output then
    return nil, "无法读取本机 TCP 监听。请检查 ss 是否可用及宿主读取权限，或改用手填上游。"
  end
  local ports = managementPorts(settings)
  local selfPid = (readSmall("/proc/self/stat", 64) or ""):match("^(%d+)")
  local endpoints = {}
  for _, line in ipairs(util.splitLines(output)) do
    local address, extra = listenerLine(line)
    if address then
      local hostname, port = unpackAddress(address)
      local inode = extra:match("%sino:(%d+)") or extra:match("^ino:(%d+)")
      local ip = hostname == "*" and "::" or hostname
      if port and (sites.canonicalIP(ip) or ip == "::") then
        local target = ip == "0.0.0.0" and "127.0.0.1" or ip == "::" and "::1" or ip
        target = authority(target, port)
        local entry = endpoints[target] or { sockets = {} }
        endpoints[target] = entry
        local blocked, name, pid, unit = ownerOf(extra, selfPid, settings)
        entry.blocked = entry.blocked or blocked or ports[port] or not inode or inode == "0"
        entry.sockets[#entry.sockets + 1] = address .. "@" .. (inode or "")
        if not entry.candidate or ip == "127.0.0.1" or ip == "::1" then
          entry.candidate = {
            address = address, upstream = target, port = port,
            process = name, pid = pid, unit = unit,
          }
        end
      end
    end
  end
  local candidates = util.array({})
  for _, entry in pairs(endpoints) do
    if not entry.blocked then
      table.sort(entry.sockets)
      entry.candidate.id = table.concat(entry.sockets, ",")
      candidates[#candidates + 1] = entry.candidate
    end
  end
  table.sort(candidates, function(a, b)
    return a.port == b.port and a.address < b.address or a.port < b.port
  end)
  return candidates
end

function M.list(settings)
  local candidates, message = snapshot(settings)
  if not candidates then return { available = false, candidates = util.array({}), message = message } end
  return { available = true, candidates = candidates }
end

function M.find(settings, id)
  if type(id) ~= "string" or id == "" or #id > 4096 then
    return nil, "请选择一个当前监听的本机服务。"
  end
  local candidates, message = snapshot(settings)
  if not candidates then return nil, message end
  for _, entry in ipairs(candidates) do
    if entry.id == id then return entry end
  end
  return nil, "所选监听已变化或不可用。请刷新监听并重新选择，或改用手填上游。"
end

function M.probe(entry)
  local result = exec("curl", {
    "-q", "--silent", "--show-error", "--noproxy", "*", "--globoff",
    "--proto", "=http", "--connect-timeout", "1", "--max-time", "2",
    "--max-filesize", "1024", "--output", "/dev/null", "--write-out", "%{http_code}",
    "--", "http://" .. entry.upstream .. "/",
  }, 2500)
  local status = result and tonumber(result.stdout)
  local kind
  if status and status >= 100 and status <= 599 then
    if status == 401 or status == 403 then kind = "restricted"
    elseif status >= 200 and status < 300 then kind = "ready"
    else kind = "responded" end
  elseif not result then kind = "unavailable"
  elseif result.timedOut or result.exitCode == 28 then kind = "timeout"
  elseif (result.stderr or ""):lower():find("permission denied", 1, true) then kind = "denied"
  else kind = "no_http" end
  return { status = kind, httpStatus = status and status >= 100 and status or nil, checkedAt = util.nowUTC() }
end

local function loopback(name)
  return name == "localhost" or name == "localhost." or name == "::1"
    or name:match("^127%.") ~= nil or name:match("^::ffff:7f[%x][%x]:") ~= nil
end

function M.proxyPools(model)
  if model.routing then
    local pools = {}
    for i, rule in ipairs(model.routing.rules) do
      pools[#pools + 1] = { proxy = rule.proxy, field = "routing.rules." .. i .. ".proxy.upstreams" }
    end
    if model.routing.fallback.type == "proxy" then
      pools[#pools + 1] = { proxy = model.routing.fallback.proxy, field = "routing.fallback.proxy.upstreams" }
    end
    return pools
  end
  if model.proxy then return { { proxy = model.proxy, field = "proxy.upstreams" } } end
  return {}
end

function M.checkPublish(settings, model, selected)
  local ports = managementPorts(settings)
  local found = selected == nil
  for _, pool in ipairs(M.proxyPools(model)) do
    for _, value in ipairs(pool.proxy.upstreams) do
      local target = value:gsub("^https?://", "")
      local name, port = unpackAddress(target)
      local isSelected = selected and selected.upstream == authority(name, port)
      local wildcard = name == "0.0.0.0" or name == "::"
      local sameDomain = util.contains(model.domains, name)
      local sameAddress = name == model.access.bindAddress
      local isLocal = isSelected or loopback(name) or wildcard or sameAddress or sameDomain
      if isSelected then found = true end
      if isLocal and ports[port] then return pool.field, "不能发布已知管理入口。" end
      local sameListener = sameDomain or sameAddress or (model.access.scope == "local" and (loopback(name) or wildcard))
        or (model.access.scope == "all" and isLocal)
      if sameListener and port == sites.accessPort(model.access) then
        return pool.field, "上游与站点入口指向同一端口，可能导致代理回环。请更改入口端口或上游。"
      end
    end
  end
  if not found then return "candidateId", "所选监听与上游不一致。请重新选择本机服务。" end
end

return M
