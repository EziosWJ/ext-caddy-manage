import api from "../api.js";
import {
  badge,
  banner,
  button,
  buttonBusy,
  chips,
  codeBlock,
  confirmDialog,
  dataTable,
  el,
  emptyState,
  errorBlock,
  feedback,
  helpTip,
  icon,
  inputField,
  loadingBlock,
  logViewer,
  linkButton,
  metaGrid,
  openDialog,
  pageHeader,
  rawEditor,
  section,
  selectField,
  switchField,
  textareaField,
  tabs,
  toast,
} from "../components.js";
import {
  certTone,
  fmtBytes,
  fmtDateTime,
  fmtDays,
  fmtRelative,
  typeLabel,
} from "../format.js";
import {
  configurationToolbar, rememberEditorMode, savedEditorMode, saveReviewedForm, viewConfiguration,
} from "./configuration.js";

import { accessDraft, accessFields, accessModel } from "./access.js";
import { routingDraft, routingEditor, routingModel } from "./routing.js";

const LB_OPTIONS = [
  { value: "round_robin", label: "轮询（round_robin）" },
  { value: "least_conn", label: "最少连接（least_conn）" },
  { value: "random", label: "随机（random）" },
  { value: "ip_hash", label: "IP 哈希（ip_hash）" },
  { value: "uri_hash", label: "URI 哈希（uri_hash）" },
  { value: "first", label: "首个可用（first）" },
];

const REDIRECT_CODES = [
  { value: "301", label: "301 永久重定向" },
  { value: "302", label: "302 临时重定向" },
  { value: "307", label: "307 临时（保留方法）" },
  { value: "308", label: "308 永久（保留方法）" },
];

const IP_MODES = [
  { value: "off", label: "关闭 IP 过滤" },
  { value: "allow", label: "仅允许列表中的地址" },
  { value: "deny", label: "拒绝列表中的地址" },
];

function parseLines(text) {
  return String(text || "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

const PROXY_ADDRESS = /^(?:https?:\/\/)?(?:[\w.-]+|\[[\da-f:.]+\]):\d+$/i;

function isDomain(address) {
  if (address.length > 253 || /^\d+\.\d+\.\d+\.\d+$/.test(address)) return false;
  return address.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

// Summarize a single straightforward proxy block. Complex routing and imports
// are left to the source viewer so the header never guesses a destination.
function proxyRouteFromFile(raw) {
  const lines = parseLines(raw).filter((line) => !line.startsWith("#"));
  const header = lines.shift()?.match(/^([\w.:/-]+) \{$/);
  if (!header || lines.pop() !== "}") return null;

  let entry = header[1];
  let upstreams;
  let inProxy = false;
  for (const line of lines) {
    if (inProxy) {
      if (line === "}") inProxy = false;
      else if (!/^(lb_policy|health_uri|health_interval|health_timeout|health_status) [^{}]+$/.test(line)) return null;
      continue;
    }
    const bind = line.match(/^bind (0\.0\.0\.0|127\.0\.0\.1)$/);
    const listener = entry.match(/^http:\/\/(127\.0\.0\.1|localhost)?:(\d+)$/);
    if (bind && listener && (!listener[1] || bind[1] === "127.0.0.1")) {
      if (!listener[1]) entry = `http://${bind[1]}:${listener[2]}`;
      continue;
    }
    const proxy = line.match(/^reverse_proxy (.+?)( \{)?$/);
    if (proxy && !upstreams) {
      upstreams = proxy[1].split(/\s+/);
      if (!upstreams.every((address) => PROXY_ADDRESS.test(address))) return null;
      inProxy = Boolean(proxy[2]);
      continue;
    }
    if (!/^(encode [\w -]+|log(?: [\w-]+)?)$/.test(line)) return null;
  }
  if (inProxy || !upstreams || !/^(?:https?:\/\/)?(?:[\w.-]+)?(?::\d+)?$/.test(entry)) return null;
  return { entry, upstreams };
}

function backupReasonLabel(reason) {
  switch (reason) {
    case "create":
      return "创建";
    case "form":
      return "表单保存";
    case "raw":
      return "原文保存";
    case "enable":
      return "启用";
    case "disable":
      return "停用";
    case "delete":
      return "删除";
    case "restore":
      return "恢复";
    case "init":
      return "初始化";
    default:
      return reason || "变更";
  }
}

function normalizeModel(detail) {
  const source = detail && detail.model && typeof detail.model === "object" ? detail.model : {};
  const security = source.security && typeof source.security === "object" ? source.security : {};
  const proxy = source.proxy && typeof source.proxy === "object" ? source.proxy : {};
  const health = proxy.health && typeof proxy.health === "object" ? proxy.health : {};
  const staticSource = source.static && typeof source.static === "object" ? source.static : {};
  const redirect = source.redirect && typeof source.redirect === "object" ? source.redirect : {};
  return {
    name: typeof source.name === "string" ? source.name : detail.name || detail.slug || "",
    type: detail.type || source.type || "static",
    domains:
      Array.isArray(source.domains) && source.domains.length > 0
        ? source.domains.map(String)
        : Array.isArray(detail.domains)
          ? detail.domains.map(String)
          : [],
    access: accessDraft(source.access, source.https !== false, true),
    routed: Boolean(source.routing),
    routing: source.routing ? routingDraft(source.routing) : null,
    group: typeof source.group === "string" ? source.group : detail.group || "",
    note: typeof source.note === "string" ? source.note : detail.note || "",
    static: {
      root: typeof staticSource.root === "string" ? staticSource.root : "",
      browse: Boolean(staticSource.browse),
      spa: Boolean(staticSource.spa),
    },
    proxy: {
      upstreams: Array.isArray(proxy.upstreams) ? proxy.upstreams.map(String) : [],
      lbPolicy: typeof proxy.lbPolicy === "string" ? proxy.lbPolicy : "round_robin",
      health: {
        enabled: Boolean(health.enabled),
        uri: typeof health.uri === "string" ? health.uri : "/health",
        interval: typeof health.interval === "string" ? health.interval : "10s",
        timeout: typeof health.timeout === "string" ? health.timeout : "3s",
        status: Number.isFinite(Number(health.status)) ? Number(health.status) : 200,
      },
      skipVerify: Boolean(proxy.skipVerify),
      hostHeader: typeof proxy.hostHeader === "string" ? proxy.hostHeader : "",
      dialTimeout: typeof proxy.dialTimeout === "string" ? proxy.dialTimeout : "5s",
      responseHeaderTimeout:
        typeof proxy.responseHeaderTimeout === "string" ? proxy.responseHeaderTimeout : "30s",
    },
    redirect: {
      target: typeof redirect.target === "string" ? redirect.target : "",
      code: Number.isFinite(Number(redirect.code)) ? Number(redirect.code) : 301,
    },
    security: {
      basicAuth: Array.isArray(security.basicAuth)
        ? security.basicAuth.map((entry) => ({
            user: entry && typeof entry.user === "string" ? entry.user : "",
            hash: entry && typeof entry.hash === "string" ? entry.hash : "",
          }))
        : [],
      ipMode: ["allow", "deny"].includes(security.ipMode) ? security.ipMode : "off",
      ipList: Array.isArray(security.ipList) ? security.ipList.map(String) : [],
      headers: Array.isArray(security.headers)
        ? security.headers.map((entry) => ({
            name: entry && typeof entry.name === "string" ? entry.name : "",
            value: entry && typeof entry.value === "string" ? entry.value : "",
          }))
        : [],
      hsts: Boolean(security.hsts),
      encode: typeof security.encode === "boolean" ? security.encode : true,
    },
  };
}

export async function mount(root, ctx, route) {
  const slug = route.slug;
  const modeKey = `ecm:editor:${location.pathname}:site:${slug}`;
  let detail = null;
  let globalInfo = null;
  let form = null;
  let initialSnapshot = "";
  let rawDirty = false;
  let dirty = false;
  let saving = false;
  let destroyed = false;
  let logsViewer = null;
  let rawEditorInstance = null;
  let refs = {};
  let dirtyIndicator = null;
  let topMessages = null;
  let ui = {};
  let activeTab = "config";
  let mode = route.section === "tls" ? "form" : savedEditorMode(modeKey);
  let reviewForm = false;

  const page = el("div", { class: "ecm-page ecm-detail-page" });
  root.append(page);

  const beforeUnload = (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);

  function displayName() {
    if (detail && detail.model && typeof detail.model.name === "string" && detail.model.name !== "") {
      return detail.model.name;
    }
    return (detail && detail.name) || slug;
  }

  function setTitle() {
    ctx.setTitle(displayName());
  }

  function formDirty() {
    return form ? JSON.stringify(form) !== initialSnapshot : false;
  }

  function updateDirty() {
    dirty = Boolean(formDirty() || rawDirty);
    if (dirtyIndicator) dirtyIndicator.hidden = !dirty;
  }

  // Prevent typing into the form while a request is in flight; otherwise the
  // post-save reload would silently discard edits made during the request.
  function setFormControlsDisabled(next) {
    if (!page) return;
    for (const control of page.querySelectorAll("input, select, textarea")) {
      if (control.closest(".ecm-raw-editor")) continue;
      if (next) {
        if (!control.disabled) {
          control.dataset.ecmDisabledBySave = "1";
          control.disabled = true;
        }
      } else if (control.dataset.ecmDisabledBySave) {
        delete control.dataset.ecmDisabledBySave;
        control.disabled = false;
      }
    }
  }

  function cleanupDynamic() {
    if (logsViewer) {
      logsViewer.destroy();
      logsViewer = null;
    }
    rawEditorInstance = null;
  }

  function showTopError(error) {
    if (!topMessages) return;
    topMessages.replaceChildren(
      feedback(error && error.message ? error.message : "操作失败", "danger", {
        details: error && error.details,
      }),
    );
    topMessages.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function confirmDiscard() {
    if (!dirty) return Promise.resolve(true);
    return confirmDialog({
      title: "放弃未保存的更改？",
      message: "当前页面有未保存的修改，继续操作会丢弃这些修改。",
      confirmLabel: "放弃更改",
      danger: true,
    });
  }

  function buildFormModel() {
    const model = {
      name: form.name.trim(),
      type: detail.type,
      domains: form.domains.map((domain) => domain.trim()).filter(Boolean),
      https: form.access.protocol !== "http",
      group: form.group.trim() || "默认",
      note: form.note,
    };
    const access = accessModel(form.access);
    if (access) model.access = access;
    if (detail.type === "static") {
      model.static = {
        root: form.static.root.trim(),
        browse: Boolean(form.static.browse),
        spa: Boolean(form.static.spa),
      };
    } else if (detail.type === "proxy") {
      const health = Boolean(form.proxy.health.enabled)
        ? {
            enabled: true,
            uri: form.proxy.health.uri.trim(),
            interval: form.proxy.health.interval.trim(),
            timeout: form.proxy.health.timeout.trim(),
            status: Number(form.proxy.health.status) || 0,
          }
        : { enabled: false };
      if (form.routed) model.routing = routingModel(form.routing);
      if (!form.routed || form.proxy.upstreams.length) model.proxy = {
        upstreams: form.proxy.upstreams.map((value) => value.trim()).filter(Boolean),
        lbPolicy: form.proxy.lbPolicy,
        health,
        skipVerify: Boolean(form.proxy.skipVerify),
        hostHeader: form.proxy.hostHeader.trim(),
        dialTimeout: form.proxy.dialTimeout.trim(),
        responseHeaderTimeout: form.proxy.responseHeaderTimeout.trim(),
      };
    } else if (detail.type === "redirect") {
      model.redirect = {
        target: form.redirect.target.trim(),
        code: Number(form.redirect.code) || 301,
      };
    }
    if (detail.type === "static" || detail.type === "proxy") {
      model.security = {
        basicAuth: form.security.basicAuth.map((entry) => ({
          user: entry.user.trim(),
          hash: entry.hash,
        })),
        ipMode: form.security.ipMode,
        ipList:
          form.security.ipMode === "off"
            ? []
            : form.security.ipList.map((value) => value.trim()).filter(Boolean),
        headers: form.security.headers.map((entry) => ({
          name: entry.name.trim(),
          value: entry.value,
        })),
        hsts: Boolean(form.security.hsts),
        encode: Boolean(form.security.encode),
      };
    }
    return model;
  }

  function fieldForPath(path) {
    if (!path) return null;
    if (path === "name") return refs.name;
    if (path === "group") return refs.group;
    if (path === "note") return refs.note;
    if (path === "https") return refs.protocol;
    if (path.startsWith("access.")) return refs[path.split(".")[1]];
    if (path.startsWith("routing")) return refs.routingFields?.[path] || refs.routingFields?.routing;
    if (path === "domains" || path.startsWith("domains.")) return refs.domains;
    if (path.startsWith("static.root")) return refs.root;
    if (path.startsWith("proxy.upstreams")) return refs.upstreams;
    if (path.startsWith("proxy.lbPolicy")) return refs.lbPolicy;
    if (path === "proxy.health.enabled") return refs.healthSwitch;
    if (path.startsWith("proxy.health.uri")) return refs.healthUri;
    if (path.startsWith("proxy.health.interval")) return refs.healthInterval;
    if (path.startsWith("proxy.health.timeout")) return refs.healthTimeout;
    if (path.startsWith("proxy.health.status")) return refs.healthStatus;
    if (path === "proxy.skipVerify") return refs.skipVerify;
    if (path.startsWith("proxy.hostHeader")) return refs.hostHeader;
    if (path.startsWith("proxy.dialTimeout")) return refs.dialTimeout;
    if (path.startsWith("proxy.responseHeaderTimeout")) return refs.responseHeaderTimeout;
    if (path.startsWith("redirect.target")) return refs.redirectTarget;
    if (path.startsWith("redirect.code")) return refs.redirectCode;
    if (path.startsWith("security.ipMode")) return refs.ipMode;
    if (path.startsWith("security.ipList")) return refs.ipList;
    if (path.startsWith("security.hsts")) return refs.hsts;
    if (path.startsWith("security.encode")) return refs.encode;
    return null;
  }

  function highlightField(path, message) {
    const fieldApi = fieldForPath(path);
    if (!fieldApi) return;
    if (typeof fieldApi.setError === "function") fieldApi.setError(message || "该字段无效。");
    const control = fieldApi.control;
    if (control) {
      control.closest("details")?.setAttribute("open", "");
      control.focus();
      control.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  async function reloadDetail({ preserveScroll = true } = {}) {
    const scrollY = preserveScroll ? window.scrollY : 0;
    try {
      const [nextDetail, nextGlobal] = await Promise.all([
        api.site(slug),
        api.global().catch(() => null),
      ]);
      if (destroyed) return;
      detail = nextDetail;
      globalInfo = nextGlobal;
      initForm();
      renderPage();
      setTitle();
      if (preserveScroll) {
        requestAnimationFrame(() => window.scrollTo(0, scrollY));
      }
    } catch (error) {
      if (destroyed) return;
      if (!detail) {
        renderLoadError(error);
      } else {
        showTopError(error);
        toast(error.message || "重新读取站点失败", "danger");
      }
    }
  }

  function initForm() {
    form = normalizeModel(detail);
    initialSnapshot = JSON.stringify(form);
    rawDirty = false;
    dirty = false;
  }

  function renderLoadError(error) {
    page.replaceChildren(
      pageHeader({ title: "站点详情", backHref: "#/sites", backLabel: "站点列表" }),
      errorBlock(error, {
        title: "站点加载失败",
        onRetry: () => load(),
      }),
    );
  }

  async function load() {
    page.replaceChildren(
      pageHeader({ title: "站点详情", backHref: "#/sites", backLabel: "站点列表" }),
      el("div", { class: "ecm-stack" }, loadingBlock("正在读取站点…")),
    );
    try {
      const [nextDetail, nextGlobal] = await Promise.all([
        api.site(slug),
        api.global().catch(() => null),
      ]);
      if (destroyed) return;
      detail = nextDetail;
      globalInfo = nextGlobal;
      initForm();
      renderPage();
      setTitle();
    } catch (error) {
      if (destroyed) return;
      renderLoadError(error);
    }
  }

  function buildBasicSection() {
    refs = {};
    const grid = el("div", { class: "ecm-form-grid" });
    const nameField = inputField({
      label: "站点名称",
      value: form.name,
      maxLength: 80,
      required: true,
      onInput: (value) => {
        form.name = value;
        updateDirty();
      },
    });
    const groupField = inputField({
      label: "分组",
      value: form.group,
      maxLength: 40,
      placeholder: "默认",
      onInput: (value) => {
        form.group = value;
        updateDirty();
      },
    });
    const domainsField = textareaField({
      label: "站点地址",
      value: form.domains.join("\n"),
      rows: 4,
      mono: true,
      placeholder: "example.com\n192.168.1.10\nfd00::10",
      hint: "每行填写一个客户端使用的域名或 IP。沿用旧版规则时保留原有地址格式。",
      onInput: (value) => {
        form.domains = parseLines(value);
        refs.updateHttps?.();
        updateDirty();
      },
    });
    domainsField.root.classList.add("ecm-field-full");
    grid.append(domainsField.root);
    refs.name = nameField;
    refs.group = groupField;
    refs.domains = domainsField;

    if (detail.type === "static") {
      const rootField = inputField({
        label: "站点根目录",
        value: form.static.root,
        mono: true,
        required: true,
        placeholder: "/opt/caddy/sites/<slug>",
        hint: "必须是绝对路径；Caddy 以 caddy 用户读取该目录。",
        onInput: (value) => {
          form.static.root = value;
          updateDirty();
        },
      });
      rootField.root.classList.add("ecm-field-full");
      const browseField = switchField({
        label: "目录浏览",
        checked: form.static.browse,
        onChange: (checked) => {
          form.static.browse = checked;
          updateDirty();
        },
      });
      const spaField = switchField({
        label: "SPA 回退",
        hint: "将不存在的路径重写到 /index.html。",
        checked: form.static.spa,
        onChange: (checked) => {
          form.static.spa = checked;
          updateDirty();
        },
      });
      grid.append(rootField.root, browseField.root, spaField.root);
      refs.root = rootField;
    } else if (detail.type === "redirect") {
      const targetField = inputField({
        label: "重定向目标",
        value: form.redirect.target,
        mono: true,
        required: true,
        placeholder: "https://new.example.com{uri}",
        hint: "绝对 http(s) URL，可用 {uri} 保留原始路径与查询串。",
        onInput: (value) => {
          form.redirect.target = value;
          updateDirty();
        },
      });
      targetField.root.classList.add("ecm-field-full");
      const codeField = selectField({
        label: "状态码",
        options: REDIRECT_CODES,
        value: String(form.redirect.code),
        onChange: (value) => {
          form.redirect.code = Number(value) || 301;
          updateDirty();
        },
      });
      grid.append(targetField.root, codeField.root);
      refs.redirectTarget = targetField;
      refs.redirectCode = codeField;
    }

    return section({
      title: "站点入口",
      children: [grid, el("div", { class: "ecm-form-grid ecm-subsection" }, nameField.root, groupField.root)],
    });
  }

  function buildNotesSection() {
    const noteField = textareaField({
      label: "备注",
      value: form.note,
      rows: 3,
      maxLength: 2000,
      placeholder: "可选",
      onInput: (value) => {
        form.note = value;
        updateDirty();
      },
    });
    refs.note = noteField;
    return el("details", { class: "ecm-details" },
      el("summary", null, "备注"), el("div", { class: "ecm-details-body" }, noteField.root));
  }

  function certBadge(certRow) {
    if (certRow.error) return badge("未知", "neutral", { title: certRow.error });
    return badge(fmtDays(certRow.days), certTone(certRow.days, certRow.error), {
      title: certRow.not_after ? `到期：${fmtDateTime(certRow.not_after)}` : "",
    });
  }

  function buildHttpsSection() {
    const saved = detail;
    const matchesFile = saved.formMatchesFile === true && !saved.drift && !saved.conflict;
    const status = el("div", { class: "ecm-stack", "aria-live": "polite" });
    const results = el("div", { class: "ecm-stack", "aria-live": "polite" });
    const caArea = el("div", { class: "ecm-stack", "aria-live": "polite" });
    const entry = accessFields(form.access, {
      allowLegacy: !saved.model?.access,
      addresses: () => form.domains,
      onChange: () => {
        updateStatus();
        updateDirty();
      },
    });
    const address = selectField({
      label: "检测入口",
      options: (saved.urls || []).map((url, index) => ({ value: String(index + 1), label: url })),
      value: "1",
      onChange: () => results.replaceChildren(),
    });
    const check = button("检测本机入口", {
      icon: "refresh-cw",
      compact: true,
      onClick: async () => {
        buttonBusy(check, true, "检测中…");
        address.control.disabled = true;
        try {
          const data = await api.siteEntryCheck(slug, Number(address.control.value));
          const trust = { trusted: "宿主信任", untrusted: "宿主未信任", not_applicable: "仅 HTTP", unknown: "未确认" };
          const issuance = { presented: "入口已出示证书", not_applicable: "仅 HTTP", unknown: "未确认" };
          results.replaceChildren(metaGrid([
            { label: "本机连接", value: data.connected ? "可连接" : "失败" },
            { label: "证书签发", value: issuance[data.issuance] },
            { label: "信任结果", value: trust[data.trust] },
            { label: "HTTP 响应", value: data.httpStatus || "未验证" },
            { label: "探测目标", value: data.target, mono: true },
            { label: "检测时间", value: fmtDateTime(data.checkedAt, { seconds: true }) },
            ...(data.certificate?.issuer ? [{ label: "签发者", value: data.certificate.issuer }] : []),
            ...(data.certificate?.notAfter ? [{ label: "到期时间", value: fmtDateTime(data.certificate.notAfter) }] : []),
          ]));
          if (data.error) results.append(feedback(data.error, "warning"));
        } catch (error) {
          results.replaceChildren(feedback(error.message, "danger"));
        } finally {
          buttonBusy(check, false);
          address.control.disabled = false;
        }
      },
    });
    const loadCa = button("读取运行实例的根 CA", {
      icon: "download",
      compact: true,
      onClick: async () => {
        buttonBusy(loadCa, true, "读取中…");
        try {
          const data = await api.siteRootCA(slug);
          const download = button("下载根 CA（PEM）", {
            icon: "download",
            compact: true,
            onClick: () => {
              const objectUrl = URL.createObjectURL(new Blob([data.pem], { type: "application/x-pem-file" }));
              el("a", { href: objectUrl, download: "caddy-local-root.crt" }).click();
              setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
            },
          });
          caArea.replaceChildren(
            el("p", { class: "ecm-hint" }, "请通过可信渠道核对 SHA-256 指纹，然后将根证书导入需要访问站点的客户端信任库。使用站点 URL 重新访问，确认浏览器信任证书。"),
            metaGrid([{ label: "SHA-256 指纹", value: data.fingerprint, mono: true }]),
            download,
          );
        } catch (error) {
          caArea.replaceChildren(feedback(error.message, "danger"));
        } finally {
          buttonBusy(loadCa, false);
        }
      },
    });
    const entryCheck = el("div", { class: "ecm-stack" }, address.root, check, results);
    const localCa = el("div", { class: "ecm-stack" }, loadCa, caArea);
    const refreshLegacy = button("检测证书状态", {
      icon: "refresh-cw",
      compact: true,
      onClick: async () => {
        buttonBusy(refreshLegacy, true, "探测中…");
        try {
          const result = await api.refreshCerts(true);
          if (detail === saved) saved.certs = result.items || [];
        } catch (error) {
          toast(error.message || "证书探测失败", "danger");
        } finally {
          buttonBusy(refreshLegacy, false);
          if (refreshLegacy.isConnected) updateStatus();
        }
      },
    });
    const legacyCerts = el("div", { class: "ecm-stack" });
    const legacy = el("div", { class: "ecm-stack" }, refreshLegacy, legacyCerts);
    const card = section({
      title: "访问协议与证书",
      children: el("div", { class: "ecm-stack" }, entry.root, status, entryCheck, localCa, legacy),
    });

    card.id = "ecm-site-tls";
    card.tabIndex = -1;

    function updateStatus() {
      const stable = saved.enabled && matchesFile &&
        JSON.stringify(form.access) === JSON.stringify(accessDraft(saved.model?.access, saved.model?.https !== false, true)) &&
        JSON.stringify(form.domains) === JSON.stringify(saved.domains);
      const explicit = form.access.scope !== "legacy";
      entryCheck.hidden = !(stable && explicit);
      localCa.hidden = !(stable && explicit && form.access.protocol === "internal");
      const domains = form.domains.filter(isDomain).map((domain) => domain.toLowerCase());
      legacy.hidden = !(stable && !explicit && form.access.protocol === "auto" && domains.length);
      status.replaceChildren();
      if (form.access.protocol === "auto" && globalInfo?.form?.staging) {
        status.append(feedback("全局配置启用了 Let’s Encrypt 测试环境。签发的证书需要测试环境信任。", "warning"));
      }
      if (explicit && !stable) {
        status.append(el("p", { class: "ecm-hint" }, "保存、加载并启用入口后，可检测本机访问。"));
      } else if (explicit) {
        status.append(el("p", { class: "ecm-hint" }, "入口已保存。检测会从宿主连接监听地址，并使用宿主的证书信任库。"));
      }
      legacyCerts.replaceChildren();
      if (legacy.hidden) return;
      const rows = (saved.certs || []).filter((cert) => domains.includes(cert.domain));
      if (!rows.length) return;
      legacyCerts.append(dataTable({
        label: "站点证书",
        columns: [
          { key: "domain", label: "域名", mono: true },
          { key: "issuer", label: "签发者", hideBelow: "sm" },
          { key: "not_after", label: "到期时间", render: (row) => row.not_after ? fmtDateTime(row.not_after) : "—" },
          { key: "days", label: "剩余", align: "right", render: certBadge },
          { key: "checked_at", label: "探测时间", hideBelow: "md",
            render: (row) => row.checked_at ? fmtRelative(row.checked_at) : "未探测" },
        ],
        rows,
      }));
    }

    Object.assign(refs, entry.fields);
    refs.updateHttps = () => {
      entry.update();
      updateStatus();
    };
    updateStatus();
    return card;
  }

  function buildTrafficSection() {
    const draft = form.routing || routingDraft(null, form.proxy);
    const paths = routingEditor(draft, {
      active: form.routed,
      toggle: (checked) => {
        form.routed = checked;
        if (checked) form.routing = draft;
        renderPage();
        updateDirty();
        refs.routingFields?.routing.control.focus();
      },
      change: updateDirty,
      policies: LB_OPTIONS,
    });
    refs.routingFields = paths.fields;
    if (form.routed) return section({ title: "流量去向", children: paths.root });

    const upstreamsField = textareaField({
      label: "上游地址",
      value: form.proxy.upstreams.join("\n"),
      rows: 4,
      mono: true,
      hint: "每行一个上游，支持 host:port、http(s)://host:port、[v6]:port，最多 20 个。",
      onInput: (value) => {
        form.proxy.upstreams = parseLines(value);
        refs.updateProxy?.();
        updateDirty();
      },
    });
    refs.upstreams = upstreamsField;

    return section({
      title: "流量去向",
      children: el("div", { class: "ecm-stack" }, upstreamsField.root, paths.root, buildProxySection()),
    });
  }

  function buildProxySection() {
    const lbField = selectField({
      label: "负载均衡策略",
      options: LB_OPTIONS,
      value: form.proxy.lbPolicy,
      onChange: (value) => {
        form.proxy.lbPolicy = value;
        updateDirty();
      },
    });
    refs.lbPolicy = lbField;
    const healthSwitch = switchField({
      label: "启用主动健康检查",
      checked: form.proxy.health.enabled,
      onChange: (checked) => {
        form.proxy.health.enabled = checked;
        healthFields.hidden = !checked;
        updateDirty();
      },
    });
    const healthUri = inputField({
      label: "健康检查路径",
      value: form.proxy.health.uri,
      mono: true,
      placeholder: "/health",
      onInput: (value) => {
        form.proxy.health.uri = value;
        updateDirty();
      },
    });
    const healthInterval = inputField({
      label: "检查间隔",
      value: form.proxy.health.interval,
      mono: true,
      placeholder: "10s",
      hint: "如 10s、500ms。",
      onInput: (value) => {
        form.proxy.health.interval = value;
        updateDirty();
      },
    });
    const healthTimeout = inputField({
      label: "检查超时",
      value: form.proxy.health.timeout,
      mono: true,
      placeholder: "3s",
      onInput: (value) => {
        form.proxy.health.timeout = value;
        updateDirty();
      },
    });
    const healthStatus = inputField({
      label: "期望状态码",
      type: "number",
      min: 100,
      max: 599,
      value: String(form.proxy.health.status),
      onInput: (value) => {
        form.proxy.health.status = Number(value);
        updateDirty();
      },
    });

    const healthFields = el(
      "div",
      { class: "ecm-form-grid ecm-field-full" },
      healthUri.root,
      healthInterval.root,
      healthTimeout.root,
      healthStatus.root,
    );
    healthFields.hidden = !form.proxy.health.enabled;

    const skipVerify = switchField({
      label: "跳过上游 TLS 校验",
      hint: "跳过 HTTPS 上游的证书验证，仅对以 https:// 开头的上游有效。",
      checked: form.proxy.skipVerify,
      onChange: (checked) => {
        form.proxy.skipVerify = checked;
        updateDirty();
      },
    });
    const hostHeader = inputField({
      label: "Host 请求头（header_up）",
      value: form.proxy.hostHeader,
      mono: true,
      placeholder: "example.internal",
      hint: "留空时使用 Caddy 默认的 Host 头处理方式。",
      onInput: (value) => {
        form.proxy.hostHeader = value;
        updateDirty();
      },
    });
    const dialTimeout = inputField({
      label: "连接超时",
      value: form.proxy.dialTimeout,
      mono: true,
      placeholder: "5s",
      hint: "如 5s、500ms。",
      onInput: (value) => {
        form.proxy.dialTimeout = value;
        updateDirty();
      },
    });
    const responseTimeout = inputField({
      label: "响应头超时",
      value: form.proxy.responseHeaderTimeout,
      mono: true,
      placeholder: "30s",
      onInput: (value) => {
        form.proxy.responseHeaderTimeout = value;
        updateDirty();
      },
    });

    const advanced = el(
      "details",
      { class: "ecm-details ecm-field-full" },
      el("summary", null, "高级代理选项"),
      el(
        "div",
        { class: "ecm-form-grid ecm-details-body" },
        skipVerify.root,
        hostHeader.root,
        dialTimeout.root,
        responseTimeout.root,
      ),
    );

    const grid = el(
      "div",
      { class: "ecm-form-grid" },
      lbField.root,
      healthSwitch.root,
      healthFields,
      advanced,
    );
    refs.healthSwitch = healthSwitch;
    refs.skipVerify = skipVerify;
    refs.healthUri = healthUri;
    refs.healthInterval = healthInterval;
    refs.healthTimeout = healthTimeout;
    refs.healthStatus = healthStatus;
    refs.hostHeader = hostHeader;
    refs.dialTimeout = dialTimeout;
    refs.responseHeaderTimeout = responseTimeout;
    refs.updateProxy = () => {
      skipVerify.root.hidden = !form.proxy.upstreams.some((address) => address.startsWith("https://"));
    };
    refs.updateProxy();

    return el("details", { class: "ecm-details" },
      el("summary", null, "代理池设置"),
      el("div", { class: "ecm-details-body" }, grid),
    );
  }

  async function askCredentials({ title, user = "", requireUser = false, submitLabel = "生成哈希" }) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const userField = inputField({
        label: "用户名",
        value: user,
        maxLength: 64,
        disabled: !requireUser,
        hint: requireUser ? "字母、数字、点、下划线或连字符，1–64 个字符。" : undefined,
      });
      const passwordField = inputField({
        label: requireUser ? "密码" : "新密码",
        type: "password",
        autocomplete: "new-password",
        maxLength: 1024,
        required: true,
        hint: "明文密码仅用于调用 Caddy 生成 bcrypt 哈希，不会被保存或记录。",
      });
      const errorArea = el("div", { class: "ecm-messages" });
      const formEl = el("form", { class: "ecm-stack", novalidate: true }, userField.root, passwordField.root, errorArea);
      const cancelBtn = button("取消", { variant: "secondary" });
      const submitBtn = button(submitLabel, { variant: "primary", icon: "key" });
      const handle = openDialog({
        title,
        body: formEl,
        actions: [cancelBtn, submitBtn],
        initialFocus: () => (requireUser ? userField.control : passwordField.control),
        onClose: () => finish(null),
      });
      let busy = false;
      const submit = async () => {
        if (busy) return;
        const nextUser = userField.control.value.trim();
        const password = passwordField.control.value;
        userField.setError("");
        passwordField.setError("");
        errorArea.replaceChildren();
        if (requireUser && !/^[A-Za-z0-9._-]{1,64}$/.test(nextUser)) {
          userField.setError("用户名只能包含字母、数字、点、下划线和连字符（1-64）。");
          userField.control.focus();
          return;
        }
        if (password === "") {
          passwordField.setError("请输入密码。");
          passwordField.control.focus();
          return;
        }
        busy = true;
        // Remove the plaintext from the DOM before the async round trip.
        passwordField.control.value = "";
        buttonBusy(submitBtn, true, "生成中…");
        cancelBtn.disabled = true;
        try {
          const result = await api.hash(password);
          finish({ user: requireUser ? nextUser : user, hash: result.hash });
          handle.close("ok");
        } catch (error) {
          busy = false;
          buttonBusy(submitBtn, false);
          cancelBtn.disabled = false;
          errorArea.replaceChildren(
            feedback(error.message || "生成密码哈希失败", "danger", { details: error.details }),
          );
          passwordField.control.focus();
        }
      };
      submitBtn.addEventListener("click", (event) => {
        event.preventDefault();
        submit();
      });
      cancelBtn.addEventListener("click", () => handle.close("cancel"));
      formEl.addEventListener("submit", (event) => {
        event.preventDefault();
        submit();
      });
      formEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          submit();
        }
      });
    });
  }

  function buildSecuritySection() {
    refs = refs || {};
    const body = el("div", { class: "ecm-stack" });
    const encodeField = switchField({
      label: "压缩响应",
      hint: "启用 Zstandard 和 gzip 响应压缩。",
      checked: form.security.encode,
      onChange: (checked) => {
        form.security.encode = checked;
        updateDirty();
      },
    });
    const hstsField = switchField({
      label: "HSTS",
      hint: "让浏览器后续只用 HTTPS 访问本站，仅在 HTTPS 站点生效。",
      checked: form.security.hsts,
      onChange: (checked) => {
        form.security.hsts = checked;
        updateDirty();
      },
    });
    refs.encode = encodeField;
    refs.hsts = hstsField;
    const toggles = el(
      "div",
      { class: "ecm-form-grid" },
      encodeField.root,
      hstsField.root,
    );
    body.append(toggles);

    const authBlock = el("div", { class: "ecm-subsection" });
    authBlock.append(el("div", { class: "ecm-subsection-head" },
      el("h3", { class: "ecm-subtitle" }, "Basic Auth 用户"),
    ));
    const authList = el("div", { class: "ecm-rows" });
    const addAuthBtn = button("添加用户", {
      variant: "secondary",
      icon: "plus",
      compact: true,
      disabled: form.security.basicAuth.length >= 20,
      onClick: async () => {
        const result = await askCredentials({
          title: "添加 Basic Auth 用户",
          requireUser: true,
          submitLabel: "生成哈希并添加",
        });
        if (!result) return;
        form.security.basicAuth.push(result);
        renderAuthRows();
        updateDirty();
        toast("用户已添加，保存后生效。", "success");
      },
    });
    authBlock.append(authList, el("div", { class: "ecm-row-add" }, addAuthBtn));

    function renderAuthRows() {
      authList.replaceChildren();
      if (form.security.basicAuth.length === 0) {
        authList.append(el("p", { class: "ecm-hint" }, "尚未配置 Basic Auth 用户。"));
      }
      form.security.basicAuth.forEach((entry, index) => {
        const row = el("div", { class: "ecm-row ecm-auth-row" });
        const userInput = el("input", {
          class: "ecm-control",
          type: "text",
          value: entry.user,
          maxlength: 64,
          placeholder: "用户名",
          "aria-label": `用户 ${index + 1} 的用户名`,
          autocomplete: "off",
        });
        userInput.addEventListener("input", () => {
          entry.user = userInput.value;
          updateDirty();
        });
        const hashPreview = el(
          "code",
          { class: "ecm-hash", title: entry.hash },
          entry.hash ? `${entry.hash.slice(0, 14)}…` : "无哈希",
        );
        const resetBtn = button("重置密码", {
          variant: "ghost",
          icon: "key",
          compact: true,
          onClick: async () => {
            const result = await askCredentials({
              title: `重置密码：${entry.user || "用户"}`,
              user: entry.user,
              requireUser: false,
              submitLabel: "生成新哈希",
            });
            if (!result) return;
            entry.hash = result.hash;
            renderAuthRows();
            updateDirty();
            toast("密码哈希已更新，保存后生效。", "success");
          },
        });
        const removeBtn = button("", {
          variant: "ghost",
          icon: "trash",
          compact: true,
          ariaLabel: `删除用户 ${entry.user}`,
          onClick: async () => {
            const ok = await confirmDialog({
              title: "删除 Basic Auth 用户",
              message: `删除用户「${entry.user || "未命名"}」？保存后该用户将无法登录。`,
              confirmLabel: "删除用户",
              danger: true,
            });
            if (!ok) return;
            form.security.basicAuth.splice(index, 1);
            renderAuthRows();
            updateDirty();
          },
        });
        row.append(userInput, hashPreview, resetBtn, removeBtn);
        authList.append(row);
      });
      addAuthBtn.disabled = form.security.basicAuth.length >= 20;
    }
    renderAuthRows();
    body.append(authBlock);

    const ipMode = selectField({
      label: "IP 过滤模式",
      options: IP_MODES,
      value: form.security.ipMode,
      onChange: (value) => {
        form.security.ipMode = value;
        ipWrap.hidden = value === "off";
        updateDirty();
      },
    });
    const ipList = textareaField({
      label: "IP 列表",
      value: form.security.ipList.join("\n"),
      rows: 4,
      mono: true,
      placeholder: "10.0.0.0/8\n192.0.2.10\n2001:db8::/32",
      hint: "每行一个 IPv4/IPv6 地址或 CIDR，最多 100 个。",
      onInput: (value) => {
        form.security.ipList = parseLines(value);
        updateDirty();
      },
    });
    const ipWrap = ipList.root;
    ipWrap.classList.add("ecm-field-full");
    ipWrap.hidden = form.security.ipMode === "off";
    const ipBlock = el(
      "div",
      { class: "ecm-subsection" },
      el("h3", { class: "ecm-subtitle" }, "IP 访问控制"),
      el("div", { class: "ecm-form-grid" }, ipMode.root, ipWrap),
    );
    refs.ipMode = ipMode;
    refs.ipList = ipList;
    body.append(ipBlock);

    const headerBlock = el("div", { class: "ecm-subsection" });
    headerBlock.append(
      el(
        "div",
        { class: "ecm-subsection-head" },
        el(
          "div",
          { class: "ecm-heading-with-help" },
          el("h3", { class: "ecm-subtitle" }, "自定义响应头"),
          helpTip("名称不区分大小写且不能重复，值不能包含换行。", "自定义响应头"),
        ),
      ),
    );
    const headerList = el("div", { class: "ecm-rows" });
    const addHeaderBtn = button("添加响应头", {
      variant: "secondary",
      icon: "plus",
      compact: true,
      disabled: form.security.headers.length >= 20,
      onClick: () => {
        if (form.security.headers.length >= 20) return;
        form.security.headers.push({ name: "", value: "" });
        renderHeaderRows();
        updateDirty();
      },
    });

    function renderHeaderRows() {
      headerList.replaceChildren();
      if (form.security.headers.length === 0) {
        headerList.append(el("p", { class: "ecm-hint" }, "尚未配置自定义响应头。"));
      }
      form.security.headers.forEach((entry, index) => {
        const row = el("div", { class: "ecm-row ecm-header-row" });
        const nameInput = el("input", {
          class: "ecm-control ecm-mono",
          type: "text",
          value: entry.name,
          maxlength: 128,
          placeholder: "X-Content-Type-Options",
          "aria-label": `响应头 ${index + 1} 名称`,
          autocomplete: "off",
        });
        nameInput.addEventListener("input", () => {
          entry.name = nameInput.value;
          updateDirty();
        });
        const valueInput = el("input", {
          class: "ecm-control ecm-mono",
          type: "text",
          value: entry.value,
          maxlength: 4096,
          placeholder: "nosniff",
          "aria-label": `响应头 ${index + 1} 值`,
          autocomplete: "off",
        });
        valueInput.addEventListener("input", () => {
          entry.value = valueInput.value;
          updateDirty();
        });
        const removeBtn = button("", {
          variant: "ghost",
          icon: "trash",
          compact: true,
          ariaLabel: `删除响应头 ${entry.name || index + 1}`,
          onClick: () => {
            form.security.headers.splice(index, 1);
            renderHeaderRows();
            updateDirty();
          },
        });
        row.append(nameInput, valueInput, removeBtn);
        headerList.append(row);
      });
      addHeaderBtn.disabled = form.security.headers.length >= 20;
    }
    renderHeaderRows();
    headerBlock.append(headerList, el("div", { class: "ecm-row-add" }, addHeaderBtn));
    body.append(headerBlock);

    return section({
      title: "访问控制与响应设置",
      children: body,
    });
  }

  function buildLogsSection() {
    if (detail.orphan) return null;
    const viewer = logViewer({
      scope: "site",
      slug,
      defaultLines: Number(detail && detail.logLines) || 500,
      showStatus: true,
    });
    logsViewer = viewer;
    const card = section({
      title: "访问日志",
      help: "按本站域名筛选服务日志，只有日志区域可见时才自动刷新。",
      children: viewer.root,
    });
    viewer.start();
    return card;
  }

  function buildRawSection() {
    if (detail.orphan) return null;
    const children = [];
    if (detail.custom) {
      children.push(
        feedback(
          "这是 conf.d 中的手写片段，没有插件元数据。只能编辑原文或启用/停用，不能使用表单编辑。",
          "info",
        ),
      );
    }
    if (detail.modelError) {
      children.push(
        feedback("表单模型快照损坏，暂时只能编辑原文；保存后的内容会同步为新的基线。", "warning"),
      );
    }
    const editor = rawEditor({
      value: detail.raw || "",
      baseline: detail.raw || "",
      maxBytes: 48 * 1024,
      saveLabel: detail.enabled ? "保存并重载" : "保存",
      saveInHeader: true,
      validateName: "片段",
      onValidate: (content) => api.validateSnippet(content),
      onFormat: (content) => api.fmt(content),
      onSave: (content, baseline, force) => api.saveRaw(slug, content, baseline, force),
      onConflictReload: () => reloadDetail(),
      onBusyChange: (busy) => {
        saving = busy;
        setSavingUi(busy, { raw: true });
      },
      onSaved: async (result) => {
        mode = "raw";
        rememberEditorMode(modeKey, "raw");
        toast(result?.apply?.message || "片段已保存。", "success");
        await reloadDetail();
      },
      onDirtyChange: (value) => {
        rawDirty = value;
        updateDirty();
      },
    });
    rawEditorInstance = editor;
    children.push(editor.root);
    return section({
      title: detail.custom ? "片段原文" : "配置文件（原文）",
      help: "保存前会校验此片段和主配置。",
      children,
    });
  }

  function buildSummaryAside() {
    const items = [
      { label: "站点标识", value: detail.slug, mono: true },
      { label: "类型", value: typeLabel(detail.type) },
      { label: "文件名", value: detail.path || "—", mono: true, title: detail.path || "" },
      { label: "大小", value: detail.size ? fmtBytes(detail.size) : "—" },
      { label: "修改时间", value: detail.mtime ? fmtDateTime(detail.mtime, { seconds: true }) : "—", title: detail.mtime ? fmtRelative(detail.mtime) : "" },
      { label: "创建时间", value: detail.createdAt ? fmtDateTime(detail.createdAt) : "—" },
      { label: "更新时间", value: detail.updatedAt ? fmtDateTime(detail.updatedAt) : "—" },
    ];
    if (detail.conflict) {
      items.push({ label: "冲突", value: "启用与停用目录同时存在片段", tone: "danger" });
    }
    return el("details", { class: "ecm-details" },
      el("summary", null, "站点信息"), el("div", { class: "ecm-details-body" }, metaGrid(items)));
  }

  async function viewBackup(item) {
    const content = el("div", { class: "ecm-stack" }, loadingBlock("正在读取备份…"));
    const closeBtn = button("关闭", { variant: "secondary" });
    const handle = openDialog({
      title: `备份 · ${item.name}`,
      body: content,
      actions: [closeBtn],
      wide: true,
      initialFocus: () => closeBtn,
    });
    closeBtn.addEventListener("click", () => handle.close());
    try {
      const data = await api.backup(item.name);
      if (!handle.dialog.open) return;
      content.replaceChildren(
        metaGrid([
          { label: "文件", value: data.name, mono: true },
          { label: "原因", value: backupReasonLabel(data.reason) },
          { label: "大小", value: fmtBytes(data.size) },
          { label: "时间", value: fmtDateTime(data.mtime, { seconds: true }) },
          { label: "目标", value: data.target || "—", mono: true },
        ]),
        codeBlock(data.content, { maxHeight: "55vh" }),
      );
    } catch (error) {
      if (!handle.dialog.open) return;
      content.replaceChildren(
        feedback(error.message || "读取备份失败", "danger", { details: error.details }),
      );
    }
  }

  function buildBackupsAside() {
    const backups = Array.isArray(detail.backups) ? detail.backups : [];
    const card = section({ title: "备份", help: "保存或变更站点状态时自动备份，最多保留 10 份。", children: [] });
    const body = card.querySelector(".ecm-card-body");
    if (backups.length === 0) {
      body.append(el("p", { class: "ecm-hint" }, "暂无备份"));
      return card;
    }
    const list = el("div", { class: "ecm-backup-list" });
    for (const item of backups) {
      const row = el("div", { class: "ecm-backup-item" });
      const info = el(
        "div",
        { class: "ecm-backup-info" },
        el("div", { class: "ecm-backup-name ecm-mono", title: item.name }, item.name),
        el(
          "div",
          { class: "ecm-hint" },
          `${fmtDateTime(item.mtime, { seconds: true })} · ${fmtBytes(item.size)} · ${backupReasonLabel(item.reason)}`,
        ),
      );
      const actions = el(
        "div",
        { class: "ecm-backup-actions" },
        button("查看", {
          variant: "ghost",
          icon: "eye",
          compact: true,
          onClick: () => viewBackup(item),
        }),
        button("恢复", {
          variant: "ghost",
          className: "ecm-file-action",
          icon: "rotate-ccw",
          compact: true,
          onClick: () => restoreBackup(item),
        }),
      );
      row.append(info, actions);
      list.append(row);
    }
    body.append(list);
    return card;
  }

  async function restoreBackup(item) {
    if (saving || !(await confirmDiscard())) return;
    const ok = await confirmDialog({
      title: "恢复备份",
      message: [
        `用备份「${item.name}」覆盖当前站点片段？`,
        el("p", { class: "ecm-dialog-emphasis" }, "恢复会先备份当前文件，然后校验整体配置并重载；失败时自动回滚。"),
      ],
      confirmLabel: "恢复并应用",
      danger: true,
    });
    if (!ok) return;
    saving = true;
    setSavingUi(true);
    toast("正在恢复备份…", "info");
    try {
      const result = await api.restoreBackup(item.name);
      const message =
        result && result.apply && result.apply.message ? result.apply.message : "备份已恢复。";
      toast(message, "success");
      await reloadDetail();
    } catch (error) {
      showTopError(error);
      toast(error.message || "恢复备份失败", "danger");
    } finally {
      saving = false;
      setSavingUi(false);
    }
  }

  async function adoptDisk() {
    if (saving || !detail.raw) return;
    if (!(await confirmDiscard())) return;
    saving = true;
    setSavingUi(true);
    toast("正在应用磁盘内容…", "info");
    try {
      const result = await api.saveRaw(slug, detail.raw, detail.raw, false);
      mode = "raw";
      rememberEditorMode(modeKey, "raw");
      const message = result && result.apply && result.apply.message ? result.apply.message : "已采用磁盘内容。";
      toast(message, "success");
      await reloadDetail();
    } catch (error) {
      showTopError(error);
    } finally {
      saving = false;
      setSavingUi(false);
    }
  }

  async function saveForm() {
    if (saving || mode === "raw") return;
    saving = true;
    setSavingUi(true);
    try {
      if (typeof detail.raw !== "string") throw new Error("无法读取当前文件，请重新读取后再保存。");
      const model = buildFormModel();
      const result = await saveReviewedForm({
        baseline: detail.raw,
        review: reviewForm || detail.formMatchesFile !== true || detail.drift,
        preview: () => api.previewSite(slug, model),
        save: (baseline) => api.updateSite(slug, model, baseline, false),
        reload: reloadDetail,
        confirmLabel: detail.enabled ? "保存并重载" : "保存",
      });
      if (!result) return;
      rememberEditorMode(modeKey, "form");
      reviewForm = false;
      initialSnapshot = JSON.stringify(form);
      updateDirty();
      const loadStatus = result?.apply?.reloaded ? "运行实例已加载" : "等待运行实例加载";
      toast(model.access ? `已保存。${loadStatus}。可在站点详情检测本机入口。` : (result?.apply?.message || "站点已保存。"), "success");
      await reloadDetail();
    } catch (error) {
      setFormControlsDisabled(false);
      if (typeof error?.details?.field === "string") highlightField(error.details.field, error.message);
      showTopError(error);
    } finally {
      saving = false;
      setSavingUi(false);
    }
  }

  function setSavingUi(next, { raw = false } = {}) {
    if (!raw) {
      if (ui.saveBtn) buttonBusy(ui.saveBtn, next, "保存中…");
      rawEditorInstance?.setDisabled(next);
    }
    if (ui.toggleBtn) ui.toggleBtn.disabled = next;
    if (ui.deleteBtn) ui.deleteBtn.disabled = next;
    if (ui.refreshBtn) ui.refreshBtn.disabled = next;
    for (const control of page.querySelectorAll(".ecm-config-toolbar button, .ecm-file-action")) {
      control.disabled = next;
    }
    setFormControlsDisabled(next);
    refs.updateHttps?.();
  }

  async function toggleEnabled() {
    if (!detail || detail.orphan || saving) return;
    if (!(await confirmDiscard())) return;
    const disabling = Boolean(detail.enabled);
    if (disabling) {
      const ok = await confirmDialog({
        title: "停用站点",
        message: `停用站点「${displayName()}」？Caddy 将立即停止为该站点提供服务，直到重新启用。`,
        confirmLabel: "停用站点",
        danger: true,
      });
      if (!ok) return;
    }
    if (ui.toggleBtn) buttonBusy(ui.toggleBtn, true, disabling ? "停用中…" : "启用中…");
    if (ui.saveBtn) ui.saveBtn.disabled = true;
    if (ui.deleteBtn) ui.deleteBtn.disabled = true;
    if (ui.refreshBtn) ui.refreshBtn.disabled = true;
    if (rawEditorInstance) rawEditorInstance.setDisabled(true);
    setFormControlsDisabled(true);
    try {
      const result = disabling
        ? await api.disableSite(slug, detail.raw)
        : await api.enableSite(slug, detail.raw);
      const message =
        result && result.apply && result.apply.message
          ? result.apply.message
          : disabling
            ? "站点已停用。"
            : "站点已启用。";
      toast(message, "success");
      await reloadDetail();
    } catch (error) {
      showTopError(error);
      toast(error.message || "操作失败", "danger");
      if (ui.toggleBtn) buttonBusy(ui.toggleBtn, false);
      if (ui.saveBtn) ui.saveBtn.disabled = false;
      if (ui.deleteBtn) ui.deleteBtn.disabled = false;
      if (ui.refreshBtn) ui.refreshBtn.disabled = false;
      if (rawEditorInstance) rawEditorInstance.setDisabled(false);
      setFormControlsDisabled(false);
    }
  }

  async function deleteSite() {
    if (!detail || detail.orphan || saving) return;
    const ok = await confirmDialog({
      title: "删除站点",
      message: [
        `删除站点「${displayName()}」及其片段？`,
        el("p", { class: "ecm-dialog-emphasis" }, "站点目录会被保留，需要时请手动清理；删除后配置会重新校验并重载。"),
      ],
      confirmLabel: "删除站点",
      danger: true,
    });
    if (!ok) return;
    if (ui.deleteBtn) buttonBusy(ui.deleteBtn, true, "删除中…");
    if (ui.saveBtn) ui.saveBtn.disabled = true;
    if (ui.toggleBtn) ui.toggleBtn.disabled = true;
    if (ui.refreshBtn) ui.refreshBtn.disabled = true;
    if (rawEditorInstance) rawEditorInstance.setDisabled(true);
    setFormControlsDisabled(true);
    try {
      await api.deleteSite(slug, detail.raw);
      dirty = false;
      toast("站点已删除，站点目录已保留。", "success");
      ctx.navigate("#/sites");
    } catch (error) {
      showTopError(error);
      toast(error.message || "删除失败", "danger");
      if (ui.deleteBtn) buttonBusy(ui.deleteBtn, false);
      if (ui.saveBtn) ui.saveBtn.disabled = false;
      if (ui.toggleBtn) ui.toggleBtn.disabled = false;
      if (ui.refreshBtn) ui.refreshBtn.disabled = false;
      if (rawEditorInstance) rawEditorInstance.setDisabled(false);
      setFormControlsDisabled(false);
    }
  }

  async function cleanupOrphan() {
    const ok = await confirmDialog({
      title: "清理孤儿记录",
      message: `清理「${displayName()}」的站点元数据？磁盘上没有对应片段，站点目录不会被删除。`,
      confirmLabel: "清理元数据",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteSite(slug);
      dirty = false;
      toast("孤儿元数据已清理。", "success");
      ctx.navigate("#/sites");
    } catch (error) {
      showTopError(error);
    }
  }

  function buildBanners() {
    const nodes = [];
    if (detail.orphan) {
      nodes.push(
        banner({
          tone: "warning",
          title: "仅剩元数据",
          message: "磁盘上已不存在该站点片段。可以清理元数据；站点目录不会被删除。",
          actions: button("清理元数据", {
            variant: "secondary",
            icon: "trash",
            compact: true,
            onClick: () => cleanupOrphan(),
          }),
        }),
      );
      return nodes;
    }
    if (detail.drift) {
      const actions = [
        button("以磁盘为准", {
          variant: "secondary",
          className: "ecm-file-action",
          icon: "download",
          compact: true,
          onClick: () => adoptDisk(),
        }),
      ];
      nodes.push(
        banner({
          tone: "warning",
          title: "磁盘上的片段已被外部修改",
          message: "当前文件与上次保存的版本不同。保存表单时会先显示差异。",
          actions,
        }),
      );
    }
    if (detail.conflict) {
      nodes.push(
        banner({
          tone: "danger",
          title: "片段目录冲突",
          message: "同一片段同时存在于启用与停用目录。请在服务器上删除其中一个文件（保留启用或停用版本），然后刷新页面；插件不会自动选择。",
        }),
      );
    }
    if (detail.modelError) {
      nodes.push(
        banner({
          tone: "warning",
          title: "表单模型损坏",
          message: "数据库中的表单快照无法解析；表单编辑已禁用，只能编辑原文。",
        }),
      );
    }
    return nodes;
  }

  function renderPage() {
    cleanupDynamic();
    ui = {};
    refs = {};
    const canEditForm =
      !detail.custom && !detail.orphan && !detail.modelError && ["static", "proxy", "redirect"].includes(detail.type);
    const raw = !canEditForm || mode === "raw";
    const configPanel = el("div", { class: "ecm-stack" });
    const viewRaw = () => viewConfiguration("站点配置文件", detail.raw);
    if (!detail.orphan) {
      configPanel.append(configurationToolbar({
        raw, canEditForm, view: viewRaw,
        switchMode: async () => {
          if (saving || !(await confirmDiscard())) return;
          mode = raw ? "form" : "raw";
          if (raw) reviewForm = true;
          initForm();
          renderPage();
          page.querySelector(".ecm-config-toolbar button")?.focus();
        },
      }));
      if (raw) {
        configPanel.append(buildRawSection());
      } else {
        configPanel.append(buildBasicSection(), buildHttpsSection());
        if (detail.type === "proxy") configPanel.append(buildTrafficSection());
        if (detail.type === "static" || detail.type === "proxy") configPanel.append(buildSecuritySection());
        configPanel.append(buildNotesSection());
      }
    }
    configPanel.append(buildSummaryAside());

    const refreshBtn = button("", {
      variant: "ghost",
      icon: "refresh-cw",
      compact: true,
      ariaLabel: "重新读取站点",
      title: "重新读取",
      onClick: async () => {
        if (saving || !(await confirmDiscard())) return;
        saving = true;
        setSavingUi(true);
        try {
          await reloadDetail();
        } finally {
          saving = false;
          setSavingUi(false);
        }
      },
    });
    ui.refreshBtn = refreshBtn;

    const saveBtn = raw ? rawEditorInstance?.saveButton : button(detail.enabled ? "保存并重载" : "保存", {
      variant: "primary",
      icon: "save",
      onClick: saveForm,
    });
    ui.saveBtn = saveBtn;

    let toggleBtn = null;
    if (!detail.orphan) {
      toggleBtn = button(detail.enabled ? "停用" : "启用", {
        variant: "secondary",
        icon: detail.enabled ? "square" : "play",
        onClick: () => toggleEnabled(),
      });
      ui.toggleBtn = toggleBtn;
    }

    let deleteBtn = null;
    if (detail.orphan) {
      deleteBtn = button("清理元数据", {
        variant: "danger",
        icon: "trash",
        onClick: () => cleanupOrphan(),
      });
    } else {
      deleteBtn = button("删除", {
        variant: "danger",
        icon: "trash",
        onClick: () => deleteSite(),
      });
    }
    ui.deleteBtn = deleteBtn;

    const actions = [refreshBtn];
    if (!detail.orphan) actions.push(linkButton("检查站点", `#/diagnostics?site=${encodeURIComponent(slug)}`, { icon: "activity" }));
    if (saveBtn) actions.push(saveBtn);
    if (toggleBtn) actions.push(toggleBtn);
    actions.push(deleteBtn);

    const badges = [];
    badges.push(
      badge(
        detail.orphan ? "仅元数据" : detail.enabled ? "已启用" : "已停用",
        detail.orphan ? "warning" : detail.enabled ? "success" : "neutral",
        { dot: true },
      ),
    );
    if (detail.custom) badges.push(badge("自定义片段", "info"));
    if (detail.conflict) badges.push(badge("目录冲突", "danger"));
    if (detail.drift) badges.push(badge("外部修改", "warning"));
    if (detail.modelError) badges.push(badge("模型异常", "warning"));

    const useFile = detail.formMatchesFile !== true || detail.drift || detail.conflict;
    const fileRoute = useFile && !detail.conflict && detail.type === "proxy" ? proxyRouteFromFile(detail.raw) : null;
    const entries = useFile ? (fileRoute ? [fileRoute.entry] : []) : detail.urls?.length ? detail.urls : detail.domains;
    const targets = useFile ? fileRoute?.upstreams : detail.type === "proxy" && !form.routed ? form.proxy.upstreams
      : detail.type === "redirect" ? [form.redirect.target] : null;
    const subtitle = el("span", { class: "ecm-detail-sub" },
      el("span", { class: "ecm-hint" }, typeLabel(detail.type)),
      entries.length ? el("span", { class: "ecm-route", role: "group", "aria-label": "站点入口与目标" },
        !useFile && detail.enabled && detail.urls?.length
          ? entries.slice(0, 6).map((url) => el("a", { class: "ecm-link ecm-chip ecm-mono", href: url, target: "_blank", rel: "noopener noreferrer" }, url))
          : chips(entries, { mono: true, limit: 6 }),
        targets?.length ? [icon("arrow-right", 16), chips(targets, { mono: true, limit: 3 })] : null,
      ) : null,
      useFile && fileRoute ? el("span", { class: "ecm-hint" },
        fileRoute.entry.startsWith("http://0.0.0.0:") ? "磁盘文件 · 监听所有 IPv4 网卡" : "磁盘文件",
      ) : null,
      useFile && !fileRoute && !detail.orphan ? button("查看磁盘文件", {
        variant: "ghost", className: "ecm-file-action", compact: true, onClick: viewRaw,
      }) : null,
    );
    if (detail.formMatchesFile === false) {
      badges.push(badge("表单与文件有差异", "warning", { title: "用表单保存前会显示将覆盖的差异。" }));
    }

    const header = pageHeader({
      title: displayName(),
      subtitle,
      backHref: "#/sites",
      backLabel: "站点列表",
      actions,
      badges,
    });
    dirtyIndicator = el("span", { class: "ecm-dirty", hidden: true }, "未保存");
    header.querySelector(".ecm-page-title-row").append(dirtyIndicator);

    topMessages = el("div", { class: "ecm-messages" });
    const logPanel = el("div", { class: "ecm-stack" });
    const backupPanel = buildBackupsAside();
    const items = [
      { id: "config", label: "配置", panel: configPanel },
      ...(!detail.orphan ? [{ id: "logs", label: "访问日志", panel: logPanel }] : []),
      { id: "backups", label: "备份", panel: backupPanel },
    ];
    if (!items.some((item) => item.id === activeTab)) activeTab = "config";
    const navigation = tabs({
      items, value: activeTab, label: "站点详情",
      onChange: (id) => {
        activeTab = id;
        for (const item of items) item.panel.hidden = item.id !== id;
        if (saveBtn) saveBtn.hidden = id !== "config";
        if (id === "logs" && !logPanel.hasChildNodes()) logPanel.append(buildLogsSection());
      },
    });

    const content = el("div", { class: "ecm-stack" }, topMessages, buildBanners());
    content.append(navigation.root, ...items.map((item) => item.panel));

    page.replaceChildren(header, content);
    updateDirty();
  }

  await load();
  if (route.section === "tls") {
    requestAnimationFrame(() => {
      const target = page.querySelector("#ecm-site-tls");
      if (target?.isConnected) {
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: "start" });
      }
    });
  }

  return {
    async beforeLeave() {
      if (saving) {
        toast("正在保存并重载，请稍候。", "warning");
        return false;
      }
      if (!dirty) return true;
      return confirmDialog({
        title: "离开站点详情？",
        message: "当前页面有未保存的修改，离开后将丢失。",
        confirmLabel: "离开",
        danger: true,
      });
    },
    destroy() {
      destroyed = true;
      cleanupDynamic();
      window.removeEventListener("beforeunload", beforeUnload);
    },
  };
}
