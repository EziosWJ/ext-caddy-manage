import api from "../api.js";
import {
  badge,
  banner,
  button,
  buttonBusy,
  codeBlock,
  confirmDialog,
  conflictDialog,
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
  toast,
} from "../components.js";
import { byteLength, fmtBytes, fmtDateTime, fmtRelative } from "../format.js";

function backupReasonLabel(reason) {
  switch (reason) {
    case "global":
      return "全局表单";
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
  let refs = {};
  let ui = {};
  let rawEditorInstance = null;

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
      pageHeader({ title: "全局配置", backHref: "#/overview", backLabel: "概览" }),
      errorBlock(error, { title: "全局配置加载失败", onRetry: () => load() }),
    );
  }

  async function load() {
    page.replaceChildren(
      pageHeader({ title: "全局配置", backHref: "#/overview", backLabel: "概览" }),
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
    const disabled = !detail.hasMarkers;
    const body = el("div", { class: "ecm-stack" });
    if (!detail.hasMarkers) {
      body.append(
        feedback(
          "未找到受管全局块，表单不可用。可以直接编辑主 Caddyfile 原文，或在诊断页生成初始配置。",
          "warning",
        ),
      );
    }
    const emailField = inputField({
      label: "ACME 邮箱",
      value: gform.email,
      type: "email",
      mono: true,
      placeholder: "you@example.com",
      hint: "写入全局块的 email 指令；留空则不生成。",
      disabled,
      onInput: (value) => {
        gform.email = value;
        updateDirty();
      },
    });
    const stagingField = switchField({
      label: "使用 Let's Encrypt staging CA",
      hint: "staging 证书不会被浏览器信任，仅用于测试。正式上线前必须关闭。",
      checked: gform.staging,
      disabled,
      onChange: (checked) => {
        gform.staging = checked;
        updateDirty();
      },
    });
    const extraField = textareaField({
      label: "额外全局指令",
      value: gform.extra,
      rows: 10,
      mono: true,
      disabled,
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

    if (gform.staging) {
      body.append(
        feedback("当前使用 Let's Encrypt staging，签发的证书不会被浏览器信任。", "warning"),
      );
    }
    body.append(
      el("div", { class: "ecm-form-grid" }, emailField.root, stagingField.root, extraField.root, extraCount),
      metaGrid([
        { label: "Admin 端点", value: gform.admin || "未配置", mono: true },
        { label: "主 Caddyfile", value: detail.path || "—", mono: true },
      ]),
    );

    const saveBtn = button("保存并重载", {
      variant: "primary",
      icon: "save",
      disabled,
      onClick: () => saveForm(saveBtn),
    });
    ui.saveBtn = saveBtn;
    body.append(el("div", { class: "ecm-toolbar" }, saveBtn));

    refs.email = emailField;
    refs.staging = stagingField;
    refs.extra = extraField;

    const card = section({
      title: "受管全局块",
      description: "只重写 # >>> ext-caddy-manage:global 与 # <<< 之间的内容，块外内容逐字节保留。",
      children: body,
    });
    if (disabled) card.classList.add("ecm-is-disabled");
    return card;
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
      fieldApi.control.focus();
      fieldApi.control.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  async function saveForm(saveBtn, opts = {}) {
    if (saving || !detail.hasMarkers) return;
    let force = Boolean(opts.force);
    if (detail.drift && !opts.skipDriftConfirm && !force) {
      const ok = await confirmDialog({
        title: "覆盖磁盘上的全局块？",
        message:
          "主 Caddyfile 的受管块已被外部修改。用表单保存会重写受管块并覆盖这些修改；块外内容仍会保留。",
        confirmLabel: "覆盖并保存",
        danger: true,
      });
      if (!ok) return;
      force = true;
    }
    if (rawDirty && !opts.skipRawConfirm) {
      const ok = await confirmDialog({
        title: "丢弃原文编辑？",
        message: "主 Caddyfile 原文编辑器中有未保存的修改，保存表单会覆盖并丢弃这些修改。",
        confirmLabel: "继续保存",
        danger: true,
      });
      if (!ok) return;
    }
    saving = true;
    buttonBusy(saveBtn, true, "保存中…");
    if (rawEditorInstance) rawEditorInstance.setDisabled(true);
    setFormControlsDisabled(true);
    try {
      let result;
      try {
        result = await api.saveGlobal(gform, detail.raw, force);
      } catch (error) {
        if (error && error.code === "conflict" && !force) {
          const choice = await conflictDialog({
            title: "检测到外部修改",
            message: error.message || "主 Caddyfile 已与基线上不同。",
            details: error.details,
          });
          if (choice === "disk") {
            await reloadGlobal();
            toast("已载入磁盘内容，本地表单修改已丢弃。", "info");
            return;
          }
          if (choice !== "overwrite") return;
          force = true;
          result = await api.saveGlobal(gform, detail.raw, true);
        } else {
          throw error;
        }
      }
      dirty = false;
      const message =
        result && result.apply && result.apply.message ? result.apply.message : "全局配置已保存。";
      toast(message, "success");
      await reloadGlobal();
      if (typeof ctx.refreshHealth === "function") ctx.refreshHealth();
    } catch (error) {
      setFormControlsDisabled(false);
      if (error && error.details && typeof error.details.field === "string") {
        highlightField(error.details.field, error.message);
      }
      showTopError(error);
    } finally {
      saving = false;
      if (saveBtn.isConnected) buttonBusy(saveBtn, false);
      if (rawEditorInstance) rawEditorInstance.setDisabled(false);
      setFormControlsDisabled(false);
    }
  }

  function buildRawSection() {
    const editor = rawEditor({
      value: detail.raw || "",
      baseline: detail.raw || "",
      maxBytes: 48 * 1024,
      saveLabel: "保存主配置",
      saveVariant: detail.hasMarkers ? "secondary" : "primary",
      validateName: "主配置",
      onValidate: (content) => api.validateMain(content),
      onFormat: (content) => api.fmt(content),
      onSave: (content, baseline, force) => api.saveGlobalRaw(content, baseline, force),
      onConflictReload: async () => {
        await reloadGlobal();
        if (typeof ctx.refreshHealth === "function") ctx.refreshHealth();
      },
      onBusyChange: (busy) => setFormControlsDisabled(busy),
      onBeforeSave: async () => {
        if (!formDirty()) return true;
        return confirmDialog({
          title: "丢弃未保存的表单修改？",
          message: "保存原文会刷新页面，并丢弃全局表单中尚未保存的修改。",
          confirmLabel: "保存原文",
          danger: true,
        });
      },
      onSaved: async () => {
        toast("主 Caddyfile 已保存并应用。", "success");
        await reloadGlobal();
        if (typeof ctx.refreshHealth === "function") ctx.refreshHealth();
      },
      onDirtyChange: (value) => {
        rawDirty = value;
        updateDirty();
      },
    });
    rawEditorInstance = editor;
    return section({
      title: "主 Caddyfile（原文）",
      description: "直接编辑完整主配置；保存前会整体校验，受管块外内容由你自行维护。",
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
    if (!(await confirmDiscard())) return;
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
    }
  }

  function buildBackupsAside() {
    const backups = Array.isArray(detail.backups) ? detail.backups : [];
    const card = section({ title: "备份", description: "最近 10 份主 Caddyfile 备份。", children: [] });
    const body = card.querySelector(".ecm-card-body");
    if (backups.length === 0) {
      body.append(el("p", { class: "ecm-hint" }, "暂无备份；保存或恢复时会自动生成。"));
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
    if (!(await confirmDiscard())) return;
    toast("正在应用磁盘内容…", "info");
    try {
      const result = await api.saveGlobalRaw(detail.raw || "", detail.raw || "", true);
      const message =
        result && result.apply && result.apply.message ? result.apply.message : "已采用磁盘内容。";
      toast(message, "success");
      await reloadGlobal();
    } catch (error) {
      showTopError(error);
    }
  }

  function buildBanners() {
    const nodes = [];
    if (!detail.hasMarkers) {
      nodes.push(
        banner({
          tone: "warning",
          title: "未找到受管全局块；表单已禁用，仅可编辑原文",
          message: "在诊断页可以生成带受管标记的初始配置；生成前会备份现有主 Caddyfile。",
          actions: linkButton("前往诊断", "#/diagnostics", { variant: "secondary", compact: true }),
        }),
      );
    }
    if (!detail.exists) {
      nodes.push(
        banner({
          tone: "warning",
          title: "主 Caddyfile 不存在",
          message: "保存全局表单或原文前，需要先创建主配置文件。",
          actions: linkButton("前往诊断", "#/diagnostics", { variant: "secondary", compact: true }),
        }),
      );
    }
    if (detail.drift) {
      const actions = [
        button("以磁盘为准", {
          variant: "secondary",
          icon: "download",
          compact: true,
          onClick: () => adoptDisk(),
        }),
      ];
      if (detail.hasMarkers) {
        actions.push(
          button("用表单覆盖", {
            variant: "secondary",
            icon: "upload",
            compact: true,
            onClick: async () => {
              const ok = await confirmDialog({
                title: "用表单覆盖受管块",
                message: "按当前表单重写受管块并覆盖磁盘上的外部修改，块外内容保持不变。",
                confirmLabel: "覆盖并保存",
                danger: true,
              });
              if (!ok) return;
              await saveForm(ui.saveBtn, { force: true, skipDriftConfirm: true });
            },
          }),
        );
      }
      nodes.push(
        banner({
          tone: "warning",
          title: "受管块已被外部修改",
          message: "主 Caddyfile 的受管块内容与插件上次写入的基线不同。",
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
    const refreshBtn = button("", {
      variant: "ghost",
      icon: "refresh-cw",
      compact: true,
      ariaLabel: "重新读取全局配置",
      title: "重新读取",
      onClick: async () => {
        if (!(await confirmDiscard())) return;
        await reloadGlobal();
      },
    });
    const diagnosticsBtn = linkButton("诊断", "#/diagnostics", { variant: "secondary", compact: true });
    const header = pageHeader({
      title: "全局配置",
      subtitle: el(
        "span",
        { class: "ecm-detail-sub" },
        el("span", { class: "ecm-mono" }, detail.path || "主 Caddyfile"),
        detail.drift ? badge("外部修改", "warning") : null,
        detail.hasMarkers ? badge("受管块", "success") : badge("无受管标记", "warning"),
      ),
      actions: [refreshBtn, diagnosticsBtn],
    });
    dirtyIndicator = el("span", { class: "ecm-dirty", hidden: true }, "未保存");
    const titleRow = header.querySelector(".ecm-page-title-row");
    if (titleRow) titleRow.append(dirtyIndicator);

    topMessages = el("div", { class: "ecm-messages" });
    const main = el("div", { class: "ecm-detail-main ecm-stack" });
    const aside = el("aside", { class: "ecm-detail-aside ecm-stack" });
    main.append(buildFormSection());
    main.append(buildRawSection());
    aside.append(
      section({
        title: "全局信息",
        children: metaGrid([
          { label: "是否存在", value: detail.exists ? "是" : "否" },
          { label: "文件大小", value: detail.size ? fmtBytes(detail.size) : "—" },
          { label: "受管标记", value: detail.hasMarkers ? "完整" : "缺失" },
          { label: "最后写入", value: detail.lastContent ? "有基线" : "无基线" },
        ]),
      }),
    );
    aside.append(buildBackupsAside());

    const content = el("div", { class: "ecm-stack" });
    content.append(topMessages);
    for (const node of buildBanners()) content.append(node);
    content.append(el("div", { class: "ecm-detail-layout" }, main, aside));
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
