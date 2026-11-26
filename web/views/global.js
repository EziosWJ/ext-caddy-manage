import api from "../api.js";
import {
  banner,
  button,
  buttonBusy,
  codeBlock,
  confirmDialog,
  el,
  errorBlock,
  feedback,
  inputField,
  linkButton,
  loadingBlock,
  metaGrid,
  openDialog,
  pageHeader,
  rawEditor,
  section,
  switchField,
  textareaField,
  tabs,
  toast,
} from "../components.js";
import { byteLength, fmtBytes, fmtDateTime, fmtRelative } from "../format.js";

import {
  configurationToolbar, rememberEditorMode, savedEditorMode, saveReviewedForm, viewConfiguration,
} from "./configuration.js";

function backupReasonLabel(reason) {
  switch (reason) {
    case "global":
      return "全局配置";
    case "raw":
      return "原文保存";
    case "restore":
      return "恢复";
    case "restore-global":
      return "恢复主配置";
    case "init":
      return "初始化";
    default:
      return reason || "变更";
  }
}

export async function mount(root, ctx) {
  const modeKey = `ecm:editor:${location.pathname}:global`;
  const page = el("div", { class: "ecm-page" });
  root.append(page);

  let detail = null;
  let gform = { email: "", staging: false, extra: "", admin: "" };
  let initialSnapshot = "";
  let rawDirty = false;
  let dirty = false;
  let saving = false;
  let destroyed = false;
  let topMessages = null;
  let dirtyIndicator = null;
  let stickyBar = null;
  let refs = {};
  let ui = {};
  let rawEditorInstance = null;
  let activeTab = "config";
  let mode = savedEditorMode(modeKey);
  let reviewForm = false;

  const beforeUnload = (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);

  function formDirty() {
    return JSON.stringify(gform) !== initialSnapshot;
  }

  function updateDirty() {
    dirty = Boolean(formDirty() || rawDirty);
    if (dirtyIndicator) dirtyIndicator.hidden = !dirty;
    if (stickyBar) stickyBar.hidden = !dirty || activeTab !== "config";
  }

  function setFormControlsDisabled(next) {
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

  function confirmDiscard() {
    if (!dirty) return Promise.resolve(true);
    return confirmDialog({
      title: "放弃未保存的更改？",
      message: "继续操作会丢弃当前页面中尚未保存的修改。",
      confirmLabel: "放弃更改",
      danger: true,
    });
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

  function initState() {
    const source = detail && detail.form && typeof detail.form === "object" ? detail.form : {};
    gform = {
      email: typeof source.email === "string" ? source.email : "",
      staging: Boolean(source.staging),
      extra: typeof source.extra === "string" ? source.extra : "",
      admin: typeof source.admin === "string" ? source.admin : "",
    };
    initialSnapshot = JSON.stringify(gform);
    rawDirty = false;
    dirty = false;
  }

  async function reloadGlobal({ preserveScroll = true } = {}) {
    const scrollY = preserveScroll ? window.scrollY : 0;
    try {
      const next = await api.global();
      if (destroyed) return;
      detail = next;
      initState();
      render();
      if (preserveScroll) requestAnimationFrame(() => window.scrollTo(0, scrollY));
    } catch (error) {
      if (destroyed) return;
      if (!detail) renderLoadError(error);
      else {
        showTopError(error);
        toast(error.message || "重新读取全局配置失败", "danger");
      }
    }
  }

  function renderLoadError(error) {
    page.replaceChildren(
      pageHeader({ title: "全局配置" }),
      errorBlock(error, { title: "全局配置加载失败", onRetry: () => load() }),
    );
  }

  async function load() {
    page.replaceChildren(
      pageHeader({ title: "全局配置" }),
      el("div", { class: "ecm-stack" }, loadingBlock("正在读取全局配置…")),
    );
    try {
      const next = await api.global();
      if (destroyed) return;
      detail = next;
      initState();
      render();
    } catch (error) {
      if (destroyed) return;
      renderLoadError(error);
    }
  }

  function buildFormSection() {
    refs = {};
    const stagingWarning = feedback("浏览器不会信任 Let’s Encrypt 测试证书。", "warning");
    stagingWarning.hidden = !gform.staging;
    const emailField = inputField({
      label: "证书账户邮箱（选填）",
      hint: "Caddy 创建 ACME 账户时使用的联系邮箱。",
      value: gform.email,
      type: "email",
      mono: true,
      placeholder: "you@example.com",
      onInput: (value) => {
        gform.email = value;
        updateDirty();
      },
    });
    const stagingField = switchField({
      label: "使用 Let’s Encrypt 测试环境",
      hint: "用于测试证书申请流程。浏览器不会信任测试证书。",
      checked: gform.staging,
      onChange: (checked) => {
        gform.staging = checked;
        stagingWarning.hidden = !checked;
        updateDirty();
      },
    });
    const extraField = textareaField({
      label: "额外全局指令",
      value: gform.extra,
      rows: 10,
      mono: true,
      placeholder: "# 每行一条全局指令\nservers {\n\ttrusted_proxies 10.0.0.0/8\n}",
      hint: "写入受管块内部；不要包含受管标记。上限 46 KiB。",
      onInput: (value) => {
        gform.extra = value;
        updateDirty();
        updateExtraCount();
      },
    });
    extraField.root.classList.add("ecm-field-full");
    const extraCount = el("p", { class: "ecm-hint ecm-counter ecm-field-full" });
    const updateExtraCount = () => {
      const bytes = byteLength(gform.extra);
      extraCount.textContent = `${fmtBytes(bytes)} / ${fmtBytes(46 * 1024)}`;
      extraCount.classList.toggle("ecm-tone-danger", bytes > 46 * 1024);
    };
    updateExtraCount();

    refs.email = emailField;
    refs.staging = stagingField;
    refs.extra = extraField;

    return section({
      title: "全局设置",
      help: "表单只写入主 Caddyfile 中受管标记包围的全局块。",
      children: el("div", { class: "ecm-stack" },
        el("p", { class: "ecm-hint" }, "公网域名的 HTTPS 由各站点设置，Caddy 会自动申请和续期。"),
        stagingWarning,
        el("div", { class: "ecm-form-grid" }, emailField.root, stagingField.root),
        el("details", { class: "ecm-details", open: Boolean(gform.extra.trim()) },
          el("summary", null, "额外全局指令"),
          el("div", { class: "ecm-stack ecm-details-body" }, extraField.root, extraCount),
        ),
      ),
    });
  }

  function highlightField(path, message) {
    const map = {
      email: refs.email,
      staging: refs.staging,
      extra: refs.extra,
      admin: null,
    };
    const fieldApi = map[path] || null;
    if (!fieldApi) return;
    if (typeof fieldApi.setError === "function") fieldApi.setError(message || "该字段无效。");
    if (fieldApi.control) {
      fieldApi.control.closest("details")?.setAttribute("open", "");
      fieldApi.control.focus();
      fieldApi.control.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  async function saveForm() {
    if (saving || mode === "raw" || !detail.hasMarkers) return;
    saving = true;
    setSavingUi(true);
    try {
      const result = await saveReviewedForm({
        baseline: detail.raw,
        review: reviewForm || detail.drift,
        preview: (baseline) => api.previewGlobal(gform, baseline),
        save: (baseline) => api.saveGlobal(gform, baseline, false),
        reload: reloadGlobal,
        confirmLabel: "保存并重载",
      });
      if (!result) return;
      rememberEditorMode(modeKey, "form");
      reviewForm = false;
      initialSnapshot = JSON.stringify(gform);
      updateDirty();
      toast(result?.apply?.message || "全局配置已保存。", "success");
      await reloadGlobal();
      ctx.refreshHealth?.();
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
    if (ui.refreshBtn) ui.refreshBtn.disabled = next;
    for (const control of page.querySelectorAll(".ecm-config-toolbar button, .ecm-file-action, .ecm-sticky-bar button")) {
      control.disabled = next;
    }
    setFormControlsDisabled(next);
  }

  function buildRawSection() {
    const editor = rawEditor({
      value: detail.raw || "",
      baseline: detail.raw || "",
      maxBytes: 48 * 1024,
      saveLabel: "保存并重载",
      saveInHeader: true,
      validateName: "主配置",
      onValidate: (content) => api.validateMain(content),
      onFormat: (content) => api.fmt(content),
      onSave: (content, baseline, force) => api.saveGlobalRaw(content, baseline, force),
      onConflictReload: async () => {
        await reloadGlobal();
        ctx.refreshHealth?.();
      },
      onBusyChange: (busy) => {
        saving = busy;
        setSavingUi(busy, { raw: true });
      },
      onSaved: async (result) => {
        mode = "raw";
        rememberEditorMode(modeKey, "raw");
        toast(result?.apply?.message || "主 Caddyfile 已保存。", "success");
        await reloadGlobal();
        ctx.refreshHealth?.();
      },
      onDirtyChange: (value) => {
        rawDirty = value;
        updateDirty();
      },
    });
    rawEditorInstance = editor;
    return section({
      title: "主 Caddyfile（原文）",
      help: "这里可以编辑整个主配置，保存前会整体校验。",
      children: [editor.root],
    });
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

  async function restoreBackup(item) {
    if (saving || !(await confirmDiscard())) return;
    const ok = await confirmDialog({
      title: "恢复备份",
      message: [
        `用备份「${item.name}」覆盖主 Caddyfile？`,
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
      await reloadGlobal();
      if (typeof ctx.refreshHealth === "function") ctx.refreshHealth();
    } catch (error) {
      showTopError(error);
      toast(error.message || "恢复备份失败", "danger");
    } finally {
      saving = false;
      setSavingUi(false);
    }
  }

  function buildBackupsAside() {
    const backups = Array.isArray(detail.backups) ? detail.backups : [];
    const card = section({ title: "备份", help: "保存或恢复时自动备份，最多保留 10 份。", children: [] });
    const body = card.querySelector(".ecm-card-body");
    if (backups.length === 0) {
      body.append(el("p", { class: "ecm-hint" }, "暂无备份"));
      return card;
    }
    const list = el("div", { class: "ecm-backup-list" });
    for (const item of backups) {
      const row = el("div", { class: "ecm-backup-item" });
      row.append(
        el(
          "div",
          { class: "ecm-backup-info" },
          el("div", { class: "ecm-backup-name ecm-mono", title: item.name }, item.name),
          el(
            "div",
            { class: "ecm-hint" },
            `${fmtDateTime(item.mtime, { seconds: true })} · ${fmtBytes(item.size)} · ${backupReasonLabel(item.reason)}`,
          ),
        ),
        el(
          "div",
          { class: "ecm-backup-actions" },
          button("查看", { variant: "ghost", icon: "eye", compact: true, onClick: () => viewBackup(item) }),
          button("恢复", {
            variant: "ghost",
            icon: "rotate-ccw",
            compact: true,
            onClick: () => restoreBackup(item),
          }),
        ),
      );
      list.append(row);
    }
    body.append(list);
    return card;
  }

  async function adoptDisk() {
    if (saving || !(await confirmDiscard())) return;
    saving = true;
    setSavingUi(true);
    toast("正在应用磁盘内容…", "info");
    try {
      const result = await api.saveGlobalRaw(detail.raw || "", detail.raw || "", false);
      mode = "raw";
      rememberEditorMode(modeKey, "raw");
      const message =
        result && result.apply && result.apply.message ? result.apply.message : "已采用磁盘内容。";
      toast(message, "success");
      await reloadGlobal();
    } catch (error) {
      showTopError(error);
    } finally {
      saving = false;
      setSavingUi(false);
    }
  }

  function buildBanners() {
    const nodes = [];
    if (!detail.hasMarkers) {
      nodes.push(
        banner({
          tone: "warning",
          title: "当前文件使用原文编辑",
          message: "表单需要受管标记。可在诊断页生成初始配置，生成前会备份现有主 Caddyfile。",
          actions: linkButton("前往诊断", "#/diagnostics", { variant: "secondary", compact: true }),
        }),
      );
    }
    if (!detail.exists) {
      nodes.push(
        banner({
          tone: "warning",
          title: "主 Caddyfile 不存在",
          message: "可在原文编辑器中保存新配置，或通过诊断页生成初始配置。",
          actions: linkButton("前往诊断", "#/diagnostics", { variant: "secondary", compact: true }),
        }),
      );
    }
    if (detail.drift) {
      const actions = button("以磁盘为准", {
        variant: "secondary", icon: "download", compact: true,
        className: "ecm-file-action", onClick: adoptDisk,
      });
      nodes.push(
        banner({
          tone: "warning",
          title: "主 Caddyfile 已被外部修改",
          message: "当前文件与上次保存的版本不同。保存表单时会先显示差异。",
          actions,
        }),
      );
    }
    return nodes;
  }

  function render() {
    refs = {};
    ui = {};
    rawEditorInstance = null;
    const raw = !detail.hasMarkers || mode === "raw";
    const configPanel = el("div", { class: "ecm-stack" },
      configurationToolbar({
        raw,
        canEditForm: detail.hasMarkers,
        view: () => viewConfiguration("主 Caddyfile", detail.raw),
        switchMode: async () => {
          if (saving || !(await confirmDiscard())) return;
          mode = raw ? "form" : "raw";
          if (raw) reviewForm = true;
          initState();
          render();
          page.querySelector(".ecm-config-toolbar button")?.focus();
        },
      }),
      raw ? buildRawSection() : buildFormSection(),
      el("details", { class: "ecm-details" },
        el("summary", null, "全局信息"),
        el("div", { class: "ecm-details-body" }, metaGrid([
          { label: "Admin 端点", value: gform.admin || "未配置", mono: true },
          { label: "文件大小", value: detail.size ? fmtBytes(detail.size) : "—" },
          { label: "受管标记", value: detail.hasMarkers ? "完整" : "缺失" },
        ])),
      ),
    );
    const refreshBtn = button("", {
      variant: "ghost",
      icon: "refresh-cw",
      compact: true,
      ariaLabel: "重新读取全局配置",
      title: "重新读取",
      onClick: async () => {
        if (saving || !(await confirmDiscard())) return;
        saving = true;
        setSavingUi(true);
        try {
          await reloadGlobal();
        } finally {
          saving = false;
          setSavingUi(false);
        }
      },
    });
    ui.refreshBtn = refreshBtn;
    const saveBtn = raw ? rawEditorInstance.saveButton : button("保存并重载", {
      variant: "primary", icon: "save", onClick: saveForm,
    });
    ui.saveBtn = saveBtn;
    const header = pageHeader({
      title: "全局配置",
      subtitle: el("span", { class: "ecm-mono" }, detail.path || "主 Caddyfile"),
      actions: [
        refreshBtn,
        linkButton("诊断", "#/diagnostics", { variant: "secondary", compact: true }),
        saveBtn,
      ],
    });
    dirtyIndicator = el("span", { class: "ecm-dirty", hidden: true }, "未保存");
    header.querySelector(".ecm-page-title-row").append(dirtyIndicator);

    topMessages = el("div", { class: "ecm-messages" });
    const items = [
      { id: "config", label: "配置", panel: configPanel },
      { id: "backups", label: "备份", panel: buildBackupsAside() },
    ];
    const navigation = tabs({
      items, value: activeTab, label: "全局配置",
      onChange: (id) => {
        activeTab = id;
        for (const item of items) item.panel.hidden = item.id !== id;
        saveBtn.hidden = id !== "config";
        if (stickyBar) stickyBar.hidden = !dirty || id !== "config";
      },
    });
    stickyBar = el(
      "div",
      { class: "ecm-sticky-bar", hidden: true, role: "region", "aria-label": "未保存更改操作栏" },
      el(
        "div",
        { class: "ecm-sticky-bar-inner" },
        el(
          "span",
          { class: "ecm-sticky-bar-text" },
          el("span", { class: "ecm-dot ecm-dot-warning", "aria-hidden": "true" }),
          "全局配置有未保存的更改",
        ),
        el(
          "div",
          { class: "ecm-sticky-bar-actions" },
          button("放弃更改", {
            variant: "ghost",
            compact: true,
            onClick: () => {
              if (saving) return;
              initState();
              render();
            },
          }),
          button("保存并重载", {
            variant: "primary",
            icon: "save",
            compact: true,
            onClick: () => saveBtn.click(),
          }),
        ),
      ),
    );
    const content = el("div", { class: "ecm-stack" },
      topMessages, buildBanners(), navigation.root, items.map((item) => item.panel), stickyBar);

    page.replaceChildren(header, content);
    updateDirty();
    ctx.setTitle("全局配置");
  }

  await load();

  return {
    async beforeLeave() {
      if (saving) {
        toast("正在保存并重载，请稍候。", "warning");
        return false;
      }
      if (!dirty) return true;
      return confirmDialog({
        title: "离开全局配置？",
        message: "当前页面有未保存的修改，离开后将丢失。",
        confirmLabel: "离开",
        danger: true,
      });
    },
    destroy() {
      destroyed = true;
      window.removeEventListener("beforeunload", beforeUnload);
    },
  };
}
