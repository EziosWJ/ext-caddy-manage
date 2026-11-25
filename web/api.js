// Plugin API client. Every call resolves with the `data` payload of the
// {ok:true,data} envelope or throws an ApiError normalized from either the
// plugin envelope or the host's {"error":"..."} response.

const API_BASE = new URL("../api/", document.baseURI);

export class ApiError extends Error {
  constructor(message, { status = 0, code = "error", details = null } = {}) {
    super(typeof message === "string" && message !== "" ? message : "请求失败");
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function buildUrl(path, query) {
  const url = new URL(path, API_BASE);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      // Absent boolean parameters mean false on the server; never send "0".
      if (typeof value === "boolean") {
        if (value) url.searchParams.set(key, "1");
        continue;
      }
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

async function request(path, { method = "GET", query, body, signal, headers } = {}) {
  const url = buildUrl(path, query);
  const init = {
    method,
    signal,
    headers: Object.assign({ Accept: "application/json" }, headers || {}),
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error && error.name === "AbortError") throw error;
    throw new ApiError("无法连接插件服务，请确认插件已启用并正在运行。", {
      code: "network_error",
      status: 0,
    });
  }

  let text = "";
  try {
    text = await response.text();
  } catch {
    text = "";
  }

  let payload = null;
  if (text !== "") {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (payload && typeof payload === "object" && payload.ok === true) {
    return payload.data;
  }

  if (payload && typeof payload === "object" && payload.ok === false && payload.error) {
    const error = payload.error;
    const message = typeof error === "string" ? error : error.message;
    throw new ApiError(typeof message === "string" ? message : `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      code: error && typeof error === "object" && typeof error.code === "string" ? error.code : "error",
      details: error && typeof error === "object" ? error.details ?? null : null,
    });
  }

  // Host-level failures use {"error":"..."} instead of the plugin envelope.
  if (payload && typeof payload === "object" && typeof payload.error === "string") {
    throw new ApiError(payload.error, {
      status: response.status,
      code: "host_error",
      details: null,
    });
  }

  if (!response.ok) {
    const trimmed = text.trim();
    throw new ApiError(trimmed !== "" ? trimmed.slice(0, 500) : `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      code: "http_error",
      details: null,
    });
  }

  // Defensive fallback for a non-enveloped success response.
  return payload;
}

function post(path, body) {
  return request(path, { method: "POST", body: body === undefined ? {} : body });
}

export const api = {
  health() {
    return request("health");
  },
  overview() {
    return request("overview");
  },

  metrics(refresh = false) {
    return refresh ? post("metrics") : request("metrics");
  },
  siteCheck(slug, index) {
    return post("site/check", { slug, index });
  },

  sites() {
    return request("sites");
  },
  site(slug) {
    return request("site", { query: { slug } });
  },
  createSite(model, publish) {
    return post("site", { model, publish });
  },
  localListeners() {
    return request("local-listeners");
  },
  probeLocalListener(candidateId) {
    return post("local-listeners/probe", { candidateId });
  },
  updateSite(slug, model, baseline, force) {
    return post("site/update", { slug, model, baseline, force: Boolean(force) });
  },
  previewSite(slug, model) {
    return post("site/preview", { slug, model });
  },
  saveRaw(slug, content, baseline, force) {
    return post("site/raw", { slug, content, baseline, force: Boolean(force) });
  },
  validateSnippet(content) {
    return post("site/validate", { content });
  },
  enableSite(slug, baseline) {
    return post("site/enable", { slug, baseline });
  },
  disableSite(slug, baseline) {
    return post("site/disable", { slug, baseline });
  },
  deleteSite(slug, baseline) {
    return post("site/delete", { slug, baseline });
  },

  global() {
    return request("global");
  },
  saveGlobal(form, baseline, force) {
    return post("global", {
      email: form.email,
      staging: Boolean(form.staging),
      extra: form.extra,
      baseline,
      force: Boolean(force),
    });
  },
  previewGlobal(form, baseline) {
    return post("global/preview", {
      email: form.email,
      staging: Boolean(form.staging),
      extra: form.extra,
      baseline,
    });
  },
  saveGlobalRaw(content, baseline, force) {
    return post("global/raw", { content, baseline, force: Boolean(force) });
  },
  validateMain(content) {
    // Raw editors validate their candidate, even when it is empty.
    return post("config/validate", { content: typeof content === "string" ? content : "" });
  },
  validateCurrent() {
    return post("config/validate", {});
  },
  fmt(content) {
    return post("config/fmt", { content });
  },
  hash(password) {
    return post("hash", { password });
  },

  service() {
    return request("service");
  },
  serviceAction(action) {
    return post(`service/${action}`, {});
  },

  logsService({ lines, q, includeAccess } = {}) {
    return request("logs/service", {
      query: { lines, q, includeAccess: includeAccess ? "1" : undefined },
    });
  },
  logsSite({ slug, lines, q, status, statusClass, signal } = {}) {
    return request("logs/site", { query: { slug, lines, q, status, statusClass }, signal });
  },
  exportUrl({ scope, slug, lines } = {}) {
    return buildUrl("logs/export", { scope, slug, lines }).toString();
  },

  certs() {
    return request("certs");
  },
  siteEntryCheck(slug, index, { get } = {}) {
    return request("site/entry-check", { query: { slug, index, get } });
  },
  siteRootCA(slug) {
    return request("site/root-ca", { query: { slug } });
  },
  refreshCerts(force) {
    return post("certs/refresh", { force: Boolean(force) });
  },

  backups({ scope, limit } = {}) {
    return request("backups", { query: { scope, limit } });
  },
  backup(name) {
    return request("backup", { query: { name } });
  },
  restoreBackup(name) {
    return post("backup/restore", { name });
  },

  diagnostics() {
    return request("diagnostics");
  },
  initConfig(overwrite) {
    return post("diagnostics/init", { overwrite: Boolean(overwrite) });
  },
};

export default api;
