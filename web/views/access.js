import { chips, el, inputField, selectField } from "../components.js";

const PROTOCOLS = [
  { value: "auto", label: "自动 HTTPS" },
  { value: "internal", label: "内网 HTTPS（Caddy 本地 CA）" },
  { value: "http", label: "仅 HTTP" },
];
const SCOPES = [
  { value: "", label: "请选择监听范围" },
  { value: "local", label: "仅本机" },
  { value: "address", label: "指定本机内网地址" },
  { value: "all", label: "所有接口" },
];
const LEGACY_LISTENER = /^(?:0\.0\.0\.0|127\.0\.0\.1|localhost):\d+$/i;

export function accessDraft(access, https = true, legacy = false) {
  return {
    protocol: access?.protocol || (https ? "auto" : "http"),
    scope: access?.scope || (legacy ? "legacy" : ""),
    bindAddress: access?.bindAddress || "",
    port: String(access?.port ?? ""),
  };
}

export function accessModel(draft) {
  if (draft.scope === "legacy") return undefined;
  const access = { protocol: draft.protocol, scope: draft.scope };
  if (draft.scope === "address") access.bindAddress = draft.bindAddress.trim();
  if (draft.port.trim()) access.port = draft.port.trim();
  return access;
}

export function accessUrls(draft, addresses) {
  if (draft.scope === "legacy") {
    return addresses.filter((value) => !value.startsWith("0.0.0.0:"))
      .map((value) => `${draft.protocol === "http" || LEGACY_LISTENER.test(value) ? "http" : "https"}://${value}`);
  }
  const scheme = draft.protocol === "http" ? "http" : "https";
  const defaultPort = scheme === "http" ? 80 : 443;
  const port = draft.port.trim() ? Number(draft.port) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  return addresses.flatMap((value) => {
    const host = value.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    const hostname = /^[a-z0-9][a-z0-9.-]*$/.test(host);
    const ipv6 = /^[0-9a-f:.]+$/.test(host) && host.includes(":");
    if (!hostname && !ipv6) return [];
    try {
      const url = new URL(`${scheme}://${ipv6 ? `[${host}]` : host}:${port}`);
      return [url.origin];
    } catch {
      return [];
    }
  });
}

export function scopeLabel(draft) {
  if (draft.scope === "legacy") return "沿用旧版规则";
  if (draft.scope === "address" && draft.bindAddress.trim()) return draft.bindAddress.trim();
  return SCOPES.find(({ value }) => value === draft.scope)?.label || "请选择监听范围";
}

export function protocolLabel(draft) {
  return PROTOCOLS.find(({ value }) => value === draft.protocol)?.label || "";
}

export function accessFields(draft, { allowLegacy = false, addresses, onChange }) {
  const protocol = selectField({
    label: "访问协议",
    options: PROTOCOLS,
    value: draft.protocol,
    onChange: (value) => {
      draft.protocol = value;
      if (value === "internal" && draft.scope === "legacy") {
        draft.scope = "";
        scope.control.value = "";
      }
      changed();
    },
  });
  const scope = selectField({
    label: "监听范围",
    options: allowLegacy ? [...SCOPES, { value: "legacy", label: "沿用旧版监听规则" }] : SCOPES,
    value: draft.scope,
    onChange: (value) => {
      draft.scope = value;
      if (value === "legacy" && draft.protocol === "internal") {
        draft.protocol = "auto";
        protocol.control.value = "auto";
      }
      changed();
    },
  });
  const bindAddress = inputField({
    label: "本机网卡地址",
    value: draft.bindAddress,
    placeholder: "192.168.1.10 或 fd00::10",
    mono: true,
    onInput: (value) => {
      draft.bindAddress = value;
      changed();
    },
  });
  const port = inputField({
    label: "访问端口",
    value: draft.port,
    type: "number",
    min: 1,
    max: 65535,
    mono: true,
    onInput: (value) => {
      draft.port = value;
      changed();
    },
  });
  const urls = el("div", { class: "ecm-field-full ecm-stack", "aria-live": "polite" });
  const scopeHint = el("p", { class: "ecm-hint ecm-field-full" });
  const root = el("div", { class: "ecm-form-grid" },
    protocol.root, scope.root, bindAddress.root, port.root, scopeHint, urls);

  function update() {
    bindAddress.root.hidden = draft.scope !== "address";
    port.root.hidden = draft.scope === "legacy";
    port.control.placeholder = draft.protocol === "http" ? "默认 80" : "默认 443";
    scopeHint.textContent = {
      local: "仅绑定回环地址。域名需在本机解析到回环地址。",
      address: "绑定所填地址。客户端使用域名时，需将域名解析到该地址。",
      all: "在所有网络接口监听。请确认防火墙放行范围符合预期。",
      legacy: "旧版带端口监听地址沿用其原有规则。",
    }[draft.scope] || "";
    scopeHint.hidden = !scopeHint.textContent;
    const entries = accessUrls(draft, addresses());
    urls.replaceChildren(
      el("span", { class: "ecm-hint" }, "访问 URL"),
      entries.length ? chips(entries, { mono: true, limit: 20 }) : el("span", { class: "ecm-hint" }, "填写站点地址后预览"),
    );
  }

  function changed() {
    update();
    onChange();
  }
  update();
  return { root, update, fields: { protocol, scope, bindAddress, port } };
}
