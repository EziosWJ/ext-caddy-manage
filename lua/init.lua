-- init.lua: register all API routes and the start hook.

local api = require("api")
local http = require("http")
local store = require("store")
local certs = require("certs")

for _, r in ipairs(api.routes) do
  host.app.route(r.method, r.path, http.wrap(r.handler))
end

host.app.on("start", function()
  local ok, err = pcall(store.ensure)
  if not ok then print("store ensure failed: "..tostring(err)) end
  pcall(certs.schedule)
end)
