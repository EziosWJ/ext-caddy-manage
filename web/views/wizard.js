import api from "../api.js";
import {
  button, buttonBusy, chips, confirmDialog, el, feedback, icon, inputField, linkButton, metaGrid, pageHeader,
  section, selectField, switchField, textareaField, toast,
} from "../components.js";
import { accessDraft, accessFields, accessModel, accessUrls, protocolLabel, scopeLabel } from "./access.js";

const SOURCES = [
  { id: "local", title: "本机服务", icon: "server", desc: "从宿主当前的 TCP 监听中选取上游。" },
  { id: "proxy", title: "手填上游", icon: "link", desc: "填写一个或多个反向代理目标。" },
  { id: "static", title: "静态目录", icon: "folder", desc: "发布本机目录中的网页或下载文件。" },
  { id: "redirect", title: "重定向", icon: "arrow-right", desc: "将请求跳转到另一个 URL。" },
];

const PROXY_PRESETS = [
  { value: "web", label: "普通 Web" },
  { value: "split", label: "SPA + API" },
];
const STATIC_PRESETS = [
  { value: "files", label: "普通静态站" },
  { value: "spa", label: "SPA" },
  { value: "download", label: "文件下载" },
];

const IP_MODES = [
  { value: "off", label: "允许可达的客户端" },
  { value: "allow", label: "仅允许所列 IP 或网段" },
  { value: "deny", label: "拒绝所列 IP 或网段" },
];

const POLICIES = {
  round_robin: "轮询", least_conn: "最少连接", random: "随机", ip_hash: "IP 哈希",
  uri_hash: "URI 哈希", first: "首个可用",
};

const PROBE_STATUS = {
  ready: "根路径返回成功",
  responded: "已收到 HTTP 响应",
  restricted: "HTTP 服务要求认证或拒绝访问",
  denied: "宿主无权连接此监听",
  timeout: "探测超时",
  unavailable: "无法运行 curl",
  no_http: "未收到 HTTP 响应",
};

const lines = (value) => value.split("\n").map((part) => part.trim()).filter(Boolean);
const domainsOf = (value) => lines(value.replaceAll(",", "\n"));
const optionsOf = (values) => Object.entries(values).map(([value, label]) => ({ value, label }));

export async function mount(root, ctx) {
  const health = await api.health().catch(() => null);
  const defaultRoot = health?.sitesRoot ? `${health.sitesRoot}/<slug>` : "站点根目录/<slug>";
  const state = {
    step: 1, source: "", proxyPreset: "web", staticPreset: "files",
    root: "", browse: false, spa: false, apiPath: "/api", apiAction: "preserve",
    upstreams: "", lbPolicy: "round_robin", redirectTarget: "", redirectCode: "301",
    name: "", domains: "", access: accessDraft(), ipMode: "off", ipList: "",
    requireAuth: false, user: "", password: "", group: "", note: "", confirmAll: false,
  };
  let discovery = null;
  let candidate = null;
  let probe = null;
  let listing = false;
  let probing = false;
  let selectionRun = 0;
  let updateProbeStatus = null;
  let publication = null;
  let creating = false;
  let dirty = false;
  let destroyed = false;
  let fields = {};
  const stepper = el("ol", { class: "ecm-steps", "aria-label": "新建站点步骤" });
  const messages = el("div", { class: "ecm-messages" });
  const panel = el("div", { class: "ecm-wizard-panel ecm-stack" });
  const footer = el("div", { class: "ecm-wizard-actions" });

  root.append(el("div", { class: "ecm-page" },
    pageHeader({ title: "新建站点", backHref: "#/sites", backLabel: "站点" }),
    el("div", { class: "ecm-wizard" }, stepper, messages, panel, footer),
  ));

  function set(key, value) {
    state[key] = value;
    dirty = true;
  }

  function showError(message, details) {
    messages.replaceChildren(feedback(message, "danger", { details }));
  }

  function focusField(field, message) {
    if (!field) return;
    field.setError(message);
    field.control.focus();
    field.control.scrollIntoView({ block: "nearest" });
  }

  function go(step) {
    state.step = step;
    if (step !== 3) state.confirmAll = false;
    messages.replaceChildren();
    render();
    const target = step === 1
      ? panel.querySelector(".ecm-type-card.is-selected") || panel.querySelector(".ecm-type-card")
      : panel.querySelector("input:not([disabled]), select:not([disabled])");
    target?.focus();
  }

  function renderSteps() {
    stepper.replaceChildren();
    ["选择发布内容", "设置访问入口", "确认并发布"].forEach((label, index) => {
      const step = index + 1;
      const done = step < state.step || publication;
      const active = step === state.step && !publication;
      stepper.append(el("li", {
        class: `ecm-step ${done ? "is-done" : active ? "is-active" : ""}`,
        "aria-current": active ? "step" : null,
      },
      el("span", { class: "ecm-step-index", "aria-hidden": "true" }, done ? icon("check", 14) : String(step)),
      el("span", { class: "ecm-step-label" }, label)));
    });
  }

  function textField(key, label, config = {}) {
    const createField = config.rows ? textareaField : inputField;
    const field = createField({ label, value: state[key], onInput: (value) => set(key, value), ...config });
    fields[key] = field;
    return field.root;
  }

  function choice(key, label, options, onChange) {
    const field = selectField({
      label, options, value: state[key],
      onChange: (value) => {
        set(key, value);
        onChange?.(value);
      },
    });
    fields[key] = field;
    return field;
  }

  function toggle(key, label, hint, afterChange) {
    const field = switchField({
      label, hint, checked: state[key],
      onChange: (value) => {
        set(key, value);
        afterChange?.(value);
      },
    });
    fields[key] = field;
    return field.root;
  }

  function renderDiscovery() {
    const live = el("div", { class: "ecm-stack", "aria-live": "polite" });
    const scan = button(discovery ? "刷新监听" : "发现本机监听", {
      variant: "secondary", icon: "refresh-cw", onClick: async () => {
        listing = true;
        candidate = null;
        probe = null;
        probing = false;
        selectionRun += 1;
        buttonBusy(scan, true, "读取中…");
        choices.hidden = true;
        status.replaceChildren();
        try {
          discovery = await api.localListeners();
        } catch (error) {
          discovery = { available: false, candidates: [], message: error.message };
        } finally {
          listing = false;
        }
        if (!destroyed && state.step === 1 && state.source === "local") {
          const scanHasFocus = document.activeElement === scan || document.activeElement === document.body;
          render();
          if (scanHasFocus) panel.querySelector("[data-listeners] button")?.focus();
        }
      },
    });
    buttonBusy(scan, listing, "读取中…");
    const selector = selectField({
      label: "TCP 监听",
      value: candidate?.id || "",
      options: [{ value: "", label: "请选择监听地址" }, ...(discovery?.candidates || []).map((entry) => ({
        value: entry.id,
        label: `${entry.address}  ${entry.process || "进程未知"}${entry.unit ? ` / ${entry.unit}` : ""}`,
      }))],
      onChange: (id) => {
        candidate = discovery.candidates.find((entry) => entry.id === id) || null;
        dirty = true;
        check();
      },
    });
    fields.candidateId = selector;
    selector.control.classList.add("ecm-mono");
    const retry = button("重试探测", { variant: "secondary", onClick: check });
    const status = el("div", { class: "ecm-stack" });
    const choices = el("div", { class: "ecm-stack", hidden: !discovery?.candidates?.length || listing },
      selector.root, status, el("div", null, retry));
    function updateStatus() {
      retry.hidden = !candidate;
      buttonBusy(retry, probing, "探测中…");
      const text = probing ? "正在探测根路径…" : probe?.message || PROBE_STATUS[probe?.status] || "";
      status.replaceChildren(
        candidate ? el("div", null, "代理目标 ", el("code", null, candidate.upstream)) : null,
        text ? el("p", { class: "ecm-hint" }, text, probe?.httpStatus ? `（HTTP ${probe.httpStatus}）` : "") : null,
      );
    }
    async function check() {
      const revision = ++selectionRun;
      probe = null;
      probing = Boolean(candidate);
      updateProbeStatus?.();
      if (!candidate) return;
      const value = await api.probeLocalListener(candidate.id).catch((error) => ({ message: error.message }));
      if (destroyed || revision !== selectionRun) return;
      probe = value;
      probing = false;
      updateProbeStatus?.();
    }
    updateProbeStatus = updateStatus;
    updateStatus();
    live.append(choices);
    if (discovery && !discovery.candidates.length && !listing) {
      live.append(feedback(discovery.message || "没有可发布的 TCP 监听。启动应用后刷新，或选择手填上游。", "warning"));
    }
    return el("div", { class: "ecm-stack", "data-listeners": "" }, el("div", null, scan), live);
  }

  function renderSource() {
    const grid = el("div", { class: "ecm-type-grid", role: "group", "aria-label": "发布来源" });
    for (const source of SOURCES) {
      const selected = state.source === source.id;
      grid.append(el("button", {
        class: `ecm-type-card${selected ? " is-selected" : ""}`,
        type: "button",
        "aria-pressed": String(selected),
        onclick: () => {
          set("source", source.id);
          go(1);
        },
      }, el("span", { class: "ecm-type-icon", "aria-hidden": "true" }, icon(source.icon, 22)),
      el("span", { class: "ecm-type-body" },
        el("span", { class: "ecm-type-title" }, source.title),
        el("span", { class: "ecm-type-desc" }, source.desc)),
      selected ? el("span", { class: "ecm-type-check", "aria-hidden": "true" }, icon("check-circle", 18)) : null));
    }
    panel.replaceChildren(section({ title: "发布来源", children: grid }));
    if (state.source) panel.append(section({ title: "发布内容", children: contentFields() }));

    footer.replaceChildren(button("取消", {
      variant: "secondary", onClick: () => ctx.navigate("#/sites"),
    }), el("span", { class: "ecm-spacer" }), button("下一步", {
      variant: "primary", icon: "arrow-right", onClick: () => {
        if (!state.source) return showError("请选择发布来源。");
        if (state.source === "local" && !candidate) return invalid("candidateId", "请选择本机监听，或改用手填上游。");
        if (state.source === "proxy" && !lines(state.upstreams).length) return invalid("upstreams", "请输入上游地址。");
        if (isSplit() && !state.root.trim()) return invalid("root", "请输入 SPA 根目录的绝对路径。");
        if (isSplit() && !state.apiPath.trim()) return invalid("apiPath", "请输入 API 路径前缀。");
        if (state.source === "redirect" && !state.redirectTarget.trim()) return invalid("redirectTarget", "请输入重定向目标。");
        go(2);
      },
    }));
  }

  function contentFields() {
    const content = el("div", { class: "ecm-stack" });
    const source = state.source;
    const preset = source === "static" ? STATIC_PRESETS : source === "redirect" ? null : PROXY_PRESETS;
    if (preset) {
      const key = source === "static" ? "staticPreset" : "proxyPreset";
      content.append(choice(key, "发布预设", preset, (value) => {
        if (key === "staticPreset") {
          state.spa = value === "spa";
          state.browse = value === "download";
        }
        render();
        fields[key].control.focus();
      }).root);
    }
    if (source === "local") content.append(renderDiscovery());
    if (source === "proxy") {
      content.append(textField("upstreams", "上游地址", {
        rows: 3, mono: true, required: true, placeholder: "127.0.0.1:3000\nhttps://backend.example.com:443",
        hint: "每行一个，支持 host:port、http(s)://host:port 或 [IPv6]:port。",
      }), choice("lbPolicy", "负载均衡策略", optionsOf(POLICIES)).root);
    }
    if (source === "static" || isSplit()) {
      content.append(textField("root", isSplit() ? "SPA 根目录" : "站点根目录", {
        mono: true, required: isSplit(), placeholder: isSplit() ? "/srv/web/dist" : defaultRoot,
        hint: isSplit() ? "填写前端构建产物的绝对路径。" : `填写绝对路径。留空使用 ${defaultRoot}。`,
      }));
    }
    if (isSplit()) {
      content.append(el("div", { class: "ecm-form-grid" },
        textField("apiPath", "API 路径前缀", { mono: true, required: true, hint: "按路径段匹配，如 /api 和 /api/users。" }),
        choice("apiAction", "转发路径", optionsOf({ preserve: "保留前缀", strip: "剥离前缀" })).root,
      ));
    } else if (source === "static") {
      content.append(el("div", { class: "ecm-form-grid" },
        toggle("browse", "目录浏览", "列出目录中的文件，供访问者打开或下载。"),
        toggle("spa", "SPA 回退", "将不存在的路径交给 /index.html。"),
      ));
    } else if (source === "redirect") {
      content.append(textField("redirectTarget", "重定向目标", {
        mono: true, required: true, placeholder: "https://new.example.com{uri}",
        hint: "填写绝对 HTTP(S) URL。使用 {uri} 保留路径与查询参数。",
      }), choice("redirectCode", "状态码", optionsOf({
        301: "301 永久重定向", 302: "302 临时重定向", 307: "307 临时（保留方法）", 308: "308 永久（保留方法）",
      })).root);
    }
    return content;
  }

  function renderAccess() {
    const entry = accessFields(state.access, {
      addresses: () => domainsOf(state.domains),
      onChange: () => {
        dirty = true;
      },
    });
    Object.assign(fields, entry.fields);
    panel.replaceChildren(section({
      title: "访问地址与监听",
      children: el("div", { class: "ecm-stack" },
        textField("name", "站点名称", { required: true, maxLength: 80, placeholder: "例如：开发文档" }),
        textField("domains", "站点地址", {
          rows: 3, mono: true, required: true, placeholder: "example.com\n192.168.1.10\nfd00::10",
          hint: "每行一个域名或 IP，端口单独填写。",
          onInput: (value) => { set("domains", value); entry.update(); },
        }), entry.root),
    }));
    if (state.source !== "redirect") {
      const ip = textField("ipList", "IP 或网段", { rows: 3, mono: true, placeholder: "192.168.1.0/24\n::1" });
      ip.hidden = state.ipMode === "off";
      const ipMode = choice("ipMode", "IP 访问限制", IP_MODES, (value) => { ip.hidden = value === "off"; });
      const credentials = el("div", { class: "ecm-form-grid", hidden: !state.requireAuth },
        textField("user", "用户名", { maxLength: 64, autocomplete: "off" }),
        textField("password", "密码", { type: "password", autocomplete: "new-password" }));
      panel.append(section({ title: "访问控制", children: el("div", { class: "ecm-stack" },
        ipMode.root, ip, toggle("requireAuth", "要求 Basic Auth", "访问者需要提供用户名和密码。",
          (checked) => { credentials.hidden = !checked; }), credentials,
      ) }));
    }

    footer.replaceChildren(backButton(1), el("span", { class: "ecm-spacer" }), button("下一步", {
      variant: "primary", icon: "arrow-right", onClick: () => {
        if (!state.name.trim()) return invalid("name", "请输入站点名称。");
        if (!domainsOf(state.domains).length) return invalid("domains", "请至少填写一个站点地址。");
        if (!state.access.scope) return invalid("scope", "请选择监听范围。");
        if (state.access.scope === "address" && !state.access.bindAddress.trim()) return invalid("bindAddress", "请输入本机网卡地址。");
        if (!accessUrls(state.access, domainsOf(state.domains)).length) return invalid("domains", "请检查站点地址和访问端口。");
        if (state.source !== "redirect") {
          if (state.ipMode !== "off" && !lines(state.ipList).length) return invalid("ipList", "请至少填写一个 IP 或网段。");
          if (state.requireAuth && !/^[A-Za-z0-9._-]{1,64}$/.test(state.user.trim())) {
            return invalid("user", "用户名可包含字母、数字、点、下划线和连字符。");
          }
          if (state.requireAuth && !state.password) return invalid("password", "请输入密码。");
        }
        go(3);
      },
    }));
  }

  function invalid(key, message) {
    showError(message);
    focusField(fields[key], message);
  }

  function backButton(step) {
    return button("上一步", { variant: "secondary", icon: "arrow-left", onClick: () => go(step) });
  }

  const isSplit = () => ["local", "proxy"].includes(state.source) && state.proxyPreset === "split";
  const upstreams = () => state.source === "local" ? [candidate?.upstream].filter(Boolean) : lines(state.upstreams);

  function renderReview() {
    const urls = accessUrls(state.access, domainsOf(state.domains));
    const security = state.source === "redirect" || state.ipMode === "off"
      ? "允许可达的客户端"
      : `${IP_MODES.find(({ value }) => value === state.ipMode).label} ${lines(state.ipList).join("、")}`;
    const summary = [
      { label: "站点名称", value: state.name.trim() },
      { label: "访问 URL", value: chips(urls, { mono: true, limit: 20 }) },
      { label: "访问协议", value: protocolLabel(state.access) },
      { label: "监听范围", value: scopeLabel(state.access) },
      { label: "访问控制", value: security },
    ];
    if (state.source !== "redirect" && state.requireAuth) summary.push({ label: "身份验证", value: `Basic Auth（${state.user.trim()}）` });
    if (state.source === "static" || isSplit()) {
      summary.push({ label: isSplit() ? "其余路径" : "根目录", value: state.root.trim() || defaultRoot, mono: true });
      summary.push({ label: "目录选项", value: [!isSplit() && state.browse && "目录浏览", (state.spa || isSplit()) && "SPA 回退"].filter(Boolean).join("、") || "无" });
    }
    if (["local", "proxy"].includes(state.source)) {
      summary.push({ label: isSplit() ? "API 上游" : "上游", value: chips(upstreams(), { mono: true, limit: 20 }) });
    }
    if (isSplit()) {
      summary.push({ label: "API 路径", value: state.apiPath.trim(), mono: true });
      summary.push({ label: "转发方式", value: state.apiAction === "strip" ? "剥离前缀" : "保留前缀" });
    }
    if (state.source === "redirect") {
      summary.push({ label: "重定向目标", value: state.redirectTarget.trim(), mono: true },
        { label: "状态码", value: state.redirectCode });
    }

    const body = el("div", { class: "ecm-stack" }, metaGrid(summary),
      el("div", { class: "ecm-form-grid" },
        textField("group", "分组", { placeholder: "默认", maxLength: 40 }),
        textField("note", "备注", { maxLength: 2000 })));
    if (state.access.scope === "all") {
      body.append(toggle("confirmAll", "确认在所有接口发布",
        "任何可到达站点监听端口的设备都可发起请求，实际访问受防火墙和上方访问控制约束。"));
    }
    panel.replaceChildren(section({ title: "发布预览", children: body }));
    const publish = button("发布站点", { variant: "primary", icon: "plus", onClick: () => create(publish) });
    footer.replaceChildren(backButton(2), el("span", { class: "ecm-spacer" }), publish);
  }

  function modelForPublish() {
    const type = state.source === "local" ? "proxy" : state.source;
    const model = {
      name: state.name.trim(), domains: domainsOf(state.domains), type, access: accessModel(state.access),
      group: state.group.trim() || "默认", note: state.note.trim(),
    };
    if (type !== "redirect") {
      model.security = {
        ipMode: state.ipMode, ipList: state.ipMode === "off" ? [] : lines(state.ipList),
      };
    }
    if (isSplit()) {
      model.routing = {
        rules: [{ match: "prefix", path: state.apiPath.trim(), action: state.apiAction, proxy: { upstreams: upstreams(), lbPolicy: state.lbPolicy } }],
        fallback: { type: "static", static: { root: state.root.trim(), spa: true, browse: false } },
      };
    } else if (type === "proxy") {
      model.proxy = { upstreams: upstreams(), lbPolicy: state.source === "local" ? "round_robin" : state.lbPolicy };
    } else if (type === "static") {
      model.static = { root: state.root.trim(), spa: state.spa, browse: state.browse };
    } else {
      model.redirect = { target: state.redirectTarget.trim(), code: Number(state.redirectCode) };
    }
    return model;
  }

  function showCreateError(error) {
    const key = error.details?.field || "";
    let step = 0;
    let field = key;
    if (key === "candidateId" || /^(static|proxy|redirect|routing)(\.|$)/.test(key)) {
      step = 1;
      if (key.includes("upstreams")) field = state.source === "local" ? "candidateId" : "upstreams";
      else if (key.endsWith(".path")) field = "apiPath";
      else if (key.endsWith(".action")) field = "apiAction";
      else if (key.endsWith(".root")) field = "root";
      else if (key === "redirect.target") field = "redirectTarget";
      else if (key === "redirect.code") field = "redirectCode";
      else if (key === "proxy.lbPolicy") field = "lbPolicy";
    } else if (/^(name|domains|access|security)(\.|$)/.test(key)) {
      step = 2;
      if (key.startsWith("access.") || key.startsWith("security.")) field = key.split(".")[1];
      if (field === "basicAuth") field = "user";
    }
    if (step) go(step);
    const status = error.details?.publication;
    const saved = status?.saved || (error.status >= 400 && error.status < 500 ? "no" : "unknown");
    const loaded = status?.loaded || (saved === "no" ? "no" : "unknown");
    const label = { yes: "是", no: "否", unknown: "待确认" };
    showError(`${error.message} 配置保存：${label[saved]}。Caddy 加载：${label[loaded]}。本机入口：未验证。`, error.details);
    focusField(fields[field], error.message);
  }

  async function create(publish) {
    if (creating) return;
    if (state.access.scope === "all" && !state.confirmAll) return invalid("confirmAll", "请确认所有接口的暴露范围。");
    creating = true;
    messages.replaceChildren();
    panel.inert = true;
    footer.querySelector("button").disabled = true;
    buttonBusy(publish, true, "发布中…");
    try {
      const model = modelForPublish();
      if (model.security && state.requireAuth) {
        const { hash } = await api.hash(state.password).catch((error) => {
          error.details = { field: "security.password", publication: { saved: "no", loaded: "no" } };
          throw error;
        });
        model.security.basicAuth = [{ user: state.user.trim(), hash }];
      }
      const result = await api.createSite(model, {
        candidateId: state.source === "local" ? candidate.id : undefined,
        confirmAll: state.confirmAll,
      });
      if (destroyed) return;
      dirty = false;
      state.password = "";
      publication = { slug: result.slug, loaded: Boolean(result.apply?.reloaded), message: result.apply?.message };
      render();
      panel.inert = false;
      creating = false;
      panel.querySelector("h2")?.focus();
      if (publication.loaded) await verifyEntry();
    } catch (error) {
      panel.inert = false;
      if (!destroyed) showCreateError(error);
    } finally {
      creating = false;
      panel.inert = false;
      if (publish.isConnected) {
        footer.querySelector("button").disabled = false;
        buttonBusy(publish, false);
      }
    }
  }

  function entryStatus() {
    const entry = publication.entry;
    if (publication.checking) return "正在验证本机入口…";
    if (!publication.loaded) return "待验证。请先启动 Caddy 或重试加载。";
    if (!entry) return "待验证";
    const status = entry.httpStatus;
    if (!status) return `待验证。${entry.error || "本机未收到 HTTP 响应。"}`;
    if (status === 401 || status === 403) return `入口可达，访问受限（HTTP ${status}）。`;
    if (status >= 400) return `入口可达，应用待确认（HTTP ${status}）。`;
    return `入口可达（HTTP ${status}）。`;
  }

  async function verifyEntry() {
    if (publication.checking) return;
    publication.checking = true;
    render();
    try {
      publication.entry = await api.siteEntryCheck(publication.slug, 1, { get: true });
    } catch (error) {
      publication.entry = { error: error.message };
    } finally {
      publication.checking = false;
      if (!destroyed) render();
    }
  }

  async function retryLoad() {
    if (publication.reloading) return;
    publication.reloading = true;
    publication.message = "正在加载配置…";
    render();
    try {
      await api.serviceAction("reload");
      publication.loaded = true;
      publication.message = "配置已重载";
    } catch (error) {
      publication.message = error.message;
    } finally {
      publication.reloading = false;
    }
    if (destroyed) return;
    if (publication.loaded) await verifyEntry();
    else render();
  }

  function renderResult() {
    const siteUrl = `#/sites/${encodeURIComponent(publication.slug)}`;
    const check = button(publication.loaded ? "重试本机入口验证" : "重试加载配置", {
      variant: "secondary",
      onClick: publication.loaded ? verifyEntry : retryLoad,
      disabled: publication.checking || publication.reloading,
    });
    const summary = el("div", { class: "ecm-stack", "aria-live": "polite" },
      metaGrid([
        { label: "配置保存", value: "已保存" },
        { label: "Caddy 加载", value: publication.loaded ? "已加载" : publication.message || "待加载" },
        { label: "本机入口", value: entryStatus() },
        { label: "验证地址", value: accessUrls(state.access, domainsOf(state.domains))[0] || "", mono: true },
      ]), el("div", null, check));
    panel.replaceChildren(section({ title: "发布结果", children: summary }));
    panel.querySelector("h2")?.setAttribute("tabindex", "-1");
    footer.replaceChildren(
      linkButton("返回站点列表", "#/sites"),
      el("span", { class: "ecm-spacer" }),
      linkButton("查看或编辑站点", siteUrl, { variant: "primary" }),
    );
  }

  function render() {
    fields = {};
    updateProbeStatus = null;
    renderSteps();
    if (publication) renderResult();
    else if (state.step === 1) renderSource();
    else if (state.step === 2) renderAccess();
    else renderReview();
  }

  const onBeforeUnload = (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  render();

  return {
    beforeLeave() {
      if (creating) {
        toast("正在发布站点，请稍候。", "warning");
        return false;
      }
      if (!dirty) return true;
      return confirmDialog({
        title: "放弃新建站点？",
        message: "已填写的内容将丢失。",
        confirmLabel: "放弃",
        danger: true,
      });
    },
    destroy() {
      destroyed = true;
      window.removeEventListener("beforeunload", onBeforeUnload);
    },
  };
}
