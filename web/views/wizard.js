import api from "../api.js";
import {
  badge,
  button,
  buttonBusy,
  chips,
  confirmDialog,
  el,
  feedback,
  icon,
  inputField,
  metaGrid,
  pageHeader,
  selectField,
  switchField,
  textareaField,
  toast,
} from "../components.js";
import { typeLabel } from "../format.js";

const TYPES = [
  {
    id: "static",
    title: "静态站点",
    icon: "folder",
    desc: "托管本地目录中的静态文件，可选目录浏览与 SPA 回退。",
    note: "root / file_server",
  },
  {
    id: "proxy",
    title: "反向代理",
    icon: "server",
    desc: "将请求转发到一个或多个后端上游，支持负载均衡与健康检查。",
    note: "reverse_proxy",
  },
  {
    id: "redirect",
    title: "重定向",
    icon: "arrow-right",
    desc: "把旧域名永久或临时跳转到新的地址，可保留原始路径。",
    note: "redir",
  },
];

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

function parseDomains(text) {
  return String(text || "")
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function splitLines(text) {
  return String(text || "")
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

export async function mount(root, ctx) {
  let health = null;
  try {
    health = await api.health();
  } catch {
    health = null;
  }
  const sitesRoot = health && health.sitesRoot ? String(health.sitesRoot) : "";

  const state = {
    step: 1,
    type: "",
    name: "",
    domainsText: "",
    group: "",
    note: "",
    https: true,
    root: "",
    browse: false,
    spa: false,
    upstreamsText: "",
    lbPolicy: "round_robin",
    redirectTarget: "",
    redirectCode: "301",
  };
  let lastRenderedStep = state.step;
  let focusTypeAfterRender = false;

  let dirty = false;
  let creating = false;
  let fields = {};
  let destroyed = false;

  const stepper = el("ol", { class: "ecm-steps", "aria-label": "新建站点步骤" });
  const feedbackArea = el("div", { class: "ecm-messages" });
  const panel = el("div", { class: "ecm-wizard-panel" });
  const footer = el("div", { class: "ecm-wizard-actions" });
  const subtitle = el("p", { class: "ecm-page-sub" }, "三步创建站点；创建后类型不可修改。");

  const header = pageHeader({
    title: "新建站点",
    backHref: "#/sites",
    backLabel: "站点",
  });
  header.querySelector(".ecm-page-heading").append(subtitle);

  const body = el("div", { class: "ecm-wizard" }, stepper, feedbackArea, panel, footer);
  root.append(el("div", { class: "ecm-page" }, header, body));

  const markDirty = () => {
    if (!dirty) dirty = true;
  };

  function clearErrors() {
    feedbackArea.replaceChildren();
    for (const fieldApi of Object.values(fields)) {
      if (fieldApi && typeof fieldApi.setError === "function") fieldApi.setError("");
    }
  }

  function showStepError(message, details) {
    feedbackArea.replaceChildren(feedback(message, "danger", { details: details || null }));
  }

  function renderStepper() {
    const labels = ["选择类型", "站点配置", "发布选项"];
    stepper.replaceChildren();
    labels.forEach((label, index) => {
      const number = index + 1;
      const status = number < state.step ? "is-done" : number === state.step ? "is-active" : "";
      const item = el("li", { class: `ecm-step ${status}` });
      if (number === state.step) item.setAttribute("aria-current", "step");
      item.append(
        el(
          "span",
          { class: "ecm-step-index", "aria-hidden": "true" },
          number < state.step ? icon("check", 14) : String(number),
        ),
        el("span", { class: "ecm-step-label" }, label),
      );
      stepper.append(item);
    });
  }

  function panelCard(title, description, content) {
    return el(
      "section",
      { class: "ecm-card" },
      el(
        "div",
        { class: "ecm-card-head" },
        el(
          "div",
          { class: "ecm-card-heading" },
          el("h2", { class: "ecm-card-title" }, title),
          description ? el("p", { class: "ecm-card-desc" }, description) : null,
        ),
      ),
      el("div", { class: "ecm-card-body" }, content),
    );
  }

  function renderStep1() {
    const grid = el("div", {
      class: "ecm-type-grid",
      role: "group",
      "aria-label": "站点类型",
    });
    for (const type of TYPES) {
      const selected = state.type === type.id;
      const card = el(
        "button",
        {
          class: `ecm-type-card${selected ? " is-selected" : ""}`,
          type: "button",
          "aria-pressed": selected ? "true" : "false",
        },
        el("span", { class: "ecm-type-icon", "aria-hidden": "true" }, icon(type.icon, 22)),
        el(
          "span",
          { class: "ecm-type-body" },
          el("span", { class: "ecm-type-title" }, type.title),
          el("span", { class: "ecm-type-desc" }, type.desc),
          el("span", { class: "ecm-type-note ecm-mono" }, type.note),
        ),
        selected ? el("span", { class: "ecm-type-check", "aria-hidden": "true" }, icon("check-circle", 18)) : null,
      );
      card.addEventListener("click", () => {
        state.type = type.id;
        markDirty();
        feedbackArea.replaceChildren();
        focusTypeAfterRender = true;
        render();
      });
      grid.append(card);
    }
    const content = el(
      "div",
      { class: "ecm-stack" },
      grid,
      el("p", { class: "ecm-hint" }, "类型决定生成的 Caddyfile 结构，创建后不能修改；需要换类型时请新建站点。"),
    );
    panel.replaceChildren(panelCard("选择站点类型", "站点类型决定可用的配置项。", content));

    const cancelBtn = button("取消", {
      variant: "secondary",
      onClick: () => cancel(),
    });
    const nextBtn = button("下一步", {
      variant: "primary",
      icon: "arrow-right",
      onClick: () => {
        if (!state.type) {
          showStepError("请选择一种站点类型。");
          return;
        }
        state.step = 2;
        clearErrors();
        render();
      },
    });
    footer.replaceChildren(cancelBtn, el("span", { class: "ecm-spacer" }), nextBtn);
  }

  function renderStep2() {
    fields = {};
    const type = state.type || "static";
    const nameField = inputField({
      label: "站点名称",
      value: state.name,
      placeholder: "例如：博客",
      required: true,
      maxLength: 80,
      onInput: (value) => {
        state.name = value;
        markDirty();
      },
    });
    nameField.root.classList.add("ecm-field-full");

    const domainsField = textareaField({
      label: "域名",
      value: state.domainsText,
      rows: 4,
      placeholder: "example.com\nwww.example.com",
      hint: "每行一个域名；小写字母、数字、连字符与点，不支持通配符、协议、端口或 IP。",
      required: true,
      mono: true,
      onInput: (value) => {
        state.domainsText = value;
        markDirty();
      },
    });
    domainsField.root.classList.add("ecm-field-full");

    const grid = el("div", { class: "ecm-form-grid" }, nameField.root, domainsField.root);

    if (type === "static") {
      const rootField = inputField({
        label: "站点根目录",
        value: state.root,
        placeholder: sitesRoot ? `${sitesRoot}/<slug>` : "留空则使用站点根目录/<slug>",
        hint: sitesRoot
          ? `留空时自动使用 ${sitesRoot}/<slug>；也可以填写绝对路径。`
          : "留空时自动使用配置的站点根目录/<slug>；也可以填写绝对路径。",
        mono: true,
        onInput: (value) => {
          state.root = value;
          markDirty();
        },
      });
      rootField.root.classList.add("ecm-field-full");
      const browseField = switchField({
        label: "目录浏览",
        hint: "启用后访问目录时列出文件（file_server browse）。",
        checked: state.browse,
        onChange: (checked) => {
          state.browse = checked;
          markDirty();
        },
      });
      const spaField = switchField({
        label: "SPA 回退",
        hint: "把不存在的路径重写到 /index.html（try_files）。",
        checked: state.spa,
        onChange: (checked) => {
          state.spa = checked;
          markDirty();
        },
      });
      grid.append(rootField.root, browseField.root, spaField.root);
      fields = { name: nameField, domains: domainsField, root: rootField };
    } else if (type === "proxy") {
      const upstreamsField = textareaField({
        label: "上游地址",
        value: state.upstreamsText,
        rows: 4,
        placeholder: "127.0.0.1:3000\nhttp://10.0.0.2:8080",
        hint: "每行一个上游：host:port、http(s)://host:port 或 [v6]:port；最多 20 个。",
        required: true,
        mono: true,
        onInput: (value) => {
          state.upstreamsText = value;
          markDirty();
        },
      });
      upstreamsField.root.classList.add("ecm-field-full");
      const lbField = selectField({
        label: "负载均衡策略",
        options: LB_OPTIONS,
        value: state.lbPolicy,
        onChange: (value) => {
          state.lbPolicy = value;
          markDirty();
        },
      });
      grid.append(upstreamsField.root, lbField.root);
      fields = { name: nameField, domains: domainsField, upstreams: upstreamsField, lbPolicy: lbField };
    } else {
      const targetField = inputField({
        label: "重定向目标",
        value: state.redirectTarget,
        placeholder: "https://new.example.com{uri}",
        hint: "必须是绝对 http(s) URL，可用 {uri} 保留原始路径。",
        required: true,
        mono: true,
        onInput: (value) => {
          state.redirectTarget = value;
          markDirty();
        },
      });
      targetField.root.classList.add("ecm-field-full");
      const codeField = selectField({
        label: "状态码",
        options: REDIRECT_CODES,
        value: state.redirectCode,
        onChange: (value) => {
          state.redirectCode = value;
          markDirty();
        },
      });
      grid.append(targetField.root, codeField.root);
      fields = { name: nameField, domains: domainsField, target: targetField, code: codeField };
    }

    const note = el(
      "p",
      { class: "ecm-hint" },
      `站点将创建为「${typeLabel(type)}」。安全选项、代理健康检查等可以在创建后的详情页继续配置。`,
    );
    const content = el("div", { class: "ecm-stack" }, grid, note);
    panel.replaceChildren(
      panelCard(
        "站点配置",
        type === "static"
          ? "填写名称、域名与静态目录。"
          : type === "proxy"
            ? "填写名称、域名与后端上游。"
            : "填写名称、域名与跳转目标。",
        content,
      ),
    );

    const backBtn = button("上一步", {
      variant: "secondary",
      icon: "arrow-left",
      onClick: () => {
        state.step = 1;
        clearErrors();
        render();
      },
    });
    const nextBtn = button("下一步", {
      variant: "primary",
      icon: "arrow-right",
      onClick: () => goToStep3(),
    });
    footer.replaceChildren(backBtn, el("span", { class: "ecm-spacer" }), nextBtn);
  }

  function validateStep2() {
    clearErrors();
    const errors = [];
    if (state.name.trim() === "") {
      fields.name && fields.name.setError("请输入站点名称。");
      errors.push(fields.name);
    } else if (state.name.trim().length > 80) {
      fields.name && fields.name.setError("名称不能超过 80 个字符。");
      errors.push(fields.name);
    }
    if (parseDomains(state.domainsText).length === 0) {
      fields.domains && fields.domains.setError("请至少填写一个域名。");
      errors.push(fields.domains);
    }
    if (state.type === "proxy" && splitLines(state.upstreamsText).length === 0) {
      fields.upstreams && fields.upstreams.setError("请至少填写一个上游地址。");
      errors.push(fields.upstreams);
    }
    if (state.type === "redirect" && state.redirectTarget.trim() === "") {
      fields.target && fields.target.setError("请输入重定向目标。");
      errors.push(fields.target);
    }
    if (errors.length > 0) {
      showStepError("请修正表单中的错误后再继续。");
      const first = errors.find(Boolean);
      if (first && first.control) {
        first.control.focus();
        first.control.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      return false;
    }
    return true;
  }

  function goToStep3() {
    if (!validateStep2()) return;
    state.step = 3;
    render();
  }

  function renderStep3() {
    fields = {};
    const httpsField = switchField({
      label: "启用 HTTPS",
      hint: "由 Caddy 自动申请并续期证书；关闭后站点只通过 HTTP 提供服务。",
      checked: state.https,
      onChange: (checked) => {
        state.https = checked;
        markDirty();
      },
    });
    const groupField = inputField({
      label: "分组",
      value: state.group,
      placeholder: "默认",
      maxLength: 40,
      hint: "可选，用于站点列表筛选。",
      onInput: (value) => {
        state.group = value;
        markDirty();
      },
    });
    const noteField = textareaField({
      label: "备注",
      value: state.note,
      rows: 3,
      maxLength: 2000,
      placeholder: "可选，记录用途、联系人或其他说明。",
      onInput: (value) => {
        state.note = value;
        markDirty();
      },
    });
    noteField.root.classList.add("ecm-field-full");
    fields = { https: httpsField, group: groupField, note: noteField };
    const grid = el("div", { class: "ecm-form-grid" }, httpsField.root, groupField.root, noteField.root);

    const domains = parseDomains(state.domainsText);
    const summaryItems = [
      { label: "类型", value: typeLabel(state.type) },
      { label: "名称", value: state.name.trim() || "—" },
      { label: "域名", value: chips(domains, { mono: true, limit: 20 }) },
      { label: "HTTPS", value: state.https ? "启用（自动证书）" : "关闭（仅 HTTP）" },
      { label: "分组", value: state.group.trim() || "默认" },
    ];
    if (state.type === "static") {
      summaryItems.push({
        label: "根目录",
        value: state.root.trim() || (sitesRoot ? `${sitesRoot}/<slug>` : "站点根目录/<slug>"),
        mono: true,
      });
      summaryItems.push({
        label: "选项",
        value: [state.browse ? "目录浏览" : null, state.spa ? "SPA 回退" : null].filter(Boolean).join("、") || "无",
      });
    } else if (state.type === "proxy") {
      summaryItems.push({ label: "上游", value: chips(splitLines(state.upstreamsText), { mono: true, limit: 20 }) });
      summaryItems.push({ label: "负载均衡", value: state.lbPolicy });
    } else if (state.type === "redirect") {
      summaryItems.push({ label: "目标", value: state.redirectTarget.trim() || "—", mono: true });
      summaryItems.push({ label: "状态码", value: state.redirectCode });
    }

    const summary = el(
      "div",
      { class: "ecm-summary" },
      el("h3", { class: "ecm-summary-title" }, "确认创建"),
      metaGrid(summaryItems),
    );
    const content = el("div", { class: "ecm-stack" }, grid, summary);
    panel.replaceChildren(panelCard("发布选项", "填写 HTTPS 与分组信息，然后创建站点。", content));

    const backBtn = button("上一步", {
      variant: "secondary",
      icon: "arrow-left",
      onClick: () => {
        state.step = 2;
        clearErrors();
        render();
      },
    });
    const createBtn = button("创建站点", {
      variant: "primary",
      icon: "plus",
      onClick: () => create(createBtn),
    });
    footer.replaceChildren(backBtn, el("span", { class: "ecm-spacer" }), createBtn);
  }

  function buildModel() {
    const model = {
      name: state.name.trim(),
      type: state.type,
      domains: parseDomains(state.domainsText),
      https: Boolean(state.https),
      group: state.group.trim() || "默认",
      note: state.note.trim(),
    };
    if (state.type === "static") {
      model.static = {
        root: state.root.trim(),
        browse: Boolean(state.browse),
        spa: Boolean(state.spa),
      };
    } else if (state.type === "proxy") {
      model.proxy = {
        upstreams: splitLines(state.upstreamsText),
        lbPolicy: state.lbPolicy,
      };
    } else if (state.type === "redirect") {
      model.redirect = {
        target: state.redirectTarget.trim(),
        code: Number(state.redirectCode) || 301,
      };
    }
    return model;
  }

  function mapErrorField(error) {
    const field =
      error && error.details && typeof error.details.field === "string" ? error.details.field : "";
    if (field === "") return null;
    if (field === "type") return { step: 1, key: null };
    if (field === "name") return { step: 2, key: "name" };
    if (field === "domains" || field.startsWith("domains.")) return { step: 2, key: "domains" };
    if (field.startsWith("static.")) return { step: 2, key: "root" };
    if (field.startsWith("proxy.")) {
      if (field.includes("upstream")) return { step: 2, key: "upstreams" };
      if (field.includes("lbPolicy")) return { step: 2, key: "lbPolicy" };
      return { step: 2, key: null };
    }
    if (field.startsWith("redirect.")) {
      return { step: 2, key: field === "redirect.code" ? "code" : "target" };
    }
    if (field === "https" || field === "group" || field === "note") {
      return { step: 3, key: field };
    }
    return null;
  }

  function handleCreateError(error) {
    const mapping = mapErrorField(error);
    if (mapping && mapping.step !== state.step) {
      state.step = mapping.step;
      render();
    }
    if (mapping && mapping.key && fields[mapping.key]) {
      fields[mapping.key].setError(error.message || "该字段无效。");
      const control = fields[mapping.key].control;
      if (control) {
        control.focus();
        control.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }
    showStepError(error.message || "创建站点失败。", error.details);
  }

  async function create(createBtn) {
    if (creating) return;
    if (!validateStep2()) {
      state.step = 2;
      render();
      return;
    }
    creating = true;
    clearErrors();
    const otherButtons = Array.from(footer.querySelectorAll("button")).filter((node) => node !== createBtn);
    otherButtons.forEach((node) => {
      node.disabled = true;
    });
    buttonBusy(createBtn, true, "创建中…");
    const model = buildModel();
    try {
      const result = await api.createSite(model);
      if (destroyed) return;
      dirty = false;
      creating = false;
      const message =
        result && result.apply && result.apply.message ? result.apply.message : "站点已创建并应用。";
      toast(message, "success");
      if (result && result.slug) {
        ctx.navigate(`#/sites/${encodeURIComponent(result.slug)}`);
      } else {
        ctx.navigate("#/sites");
      }
    } catch (error) {
      if (destroyed) return;
      creating = false;
      otherButtons.forEach((node) => {
        node.disabled = false;
      });
      handleCreateError(error);
      if (createBtn.isConnected) buttonBusy(createBtn, false);
    }
  }

  async function cancel() {
    if (dirty) {
      const ok = await confirmDialog({
        title: "放弃新建站点？",
        message: "已填写的内容将丢失。",
        confirmLabel: "放弃",
        danger: true,
      });
      if (!ok) return;
    }
    dirty = false;
    ctx.navigate("#/sites");
  }

  function focusCurrentStep() {
    if (destroyed) return;
    let target = null;
    if (state.step === 1) {
      target = panel.querySelector(".ecm-type-card.is-selected") || panel.querySelector(".ecm-type-card");
    } else {
      target = panel.querySelector("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
    }
    if (target && typeof target.focus === "function") target.focus({ preventScroll: true });
  }

  function render() {
    renderStepper();
    if (state.step === 1) renderStep1();
    else if (state.step === 2) renderStep2();
    else renderStep3();
    const stepChanged = state.step !== lastRenderedStep;
    const focusType = focusTypeAfterRender;
    lastRenderedStep = state.step;
    focusTypeAfterRender = false;
    if (stepChanged || focusType) {
      requestAnimationFrame(() => {
        if (!destroyed) focusCurrentStep();
      });
    }
  }

  render();

  const onBeforeUnload = (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return {
    beforeLeave() {
      if (creating) {
        toast("正在创建站点，请稍候。", "warning");
        return false;
      }
      if (!dirty) return true;
      return confirmDialog({
        title: "放弃新建站点？",
        message: "尚未创建站点，已填写的内容将丢失。",
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
