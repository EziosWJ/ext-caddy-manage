import api from "../api.js";
import {
  badge,
  button,
  buttonBusy,
  chips,
  confirmDialog,
  dataTable,
  emptyState,
  errorBlock,
  feedback,
  icon,
  loadingBlock,
  pageHeader,
  section,
  toast,
  el,
} from "../components.js";
import {
  certTone,
  fmtDateTime,
  fmtDays,
  fmtRelative,
  typeLabel,
} from "../format.js";

const TYPE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "static", label: "静态站点" },
  { value: "proxy", label: "反向代理" },
  { value: "redirect", label: "重定向" },
  { value: "custom", label: "自定义片段" },
];

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  { value: "enabled", label: "已启用" },
  { value: "disabled", label: "已停用" },
  { value: "custom", label: "自定义片段" },
  { value: "orphan", label: "孤儿记录" },
  { value: "conflict", label: "存在冲突" },
];

function makeSelect(options, ariaLabel) {
  const select = el("select", { class: "ecm-control ecm-control-compact", "aria-label": ariaLabel });
  for (const option of options) select.append(el("option", { value: option.value }, option.label));
  return select;
}

let previousList = null;

export async function mount(root, ctx) {
  const previous = previousList;
  const state = {
    items: [],
    groups: [],
    warnings: [],
    filters: previous?.filters || { q: "", type: "", status: "", group: "" },
    selected: new Set(),
    loading: true,
    error: null,
    busy: false,
    destroyed: false,
  };

  const refreshBtn = button("刷新", { variant: "secondary", icon: "refresh-cw", onClick: () => load() });
  const newBtn = button("新建站点", {
    variant: "primary",
    icon: "plus",
    onClick: () => ctx.navigate("#/sites/new"),
  });
  const siteCount = el("span", { class: "ecm-chip", hidden: true });

  const header = pageHeader({
    title: "站点",
    actions: [refreshBtn, newBtn],
    badges: siteCount,
  });

  const searchInput = el("input", {
    class: "ecm-control ecm-search-input",
    type: "search",
    placeholder: "搜索名称、域名或 slug",
    "aria-label": "搜索站点",
    autocomplete: "off",
  });
  const typeSelect = makeSelect(TYPE_OPTIONS, "类型筛选");
  const statusSelect = makeSelect(STATUS_OPTIONS, "状态筛选");
  const groupSelect = makeSelect([{ value: "", label: "全部分组" }], "分组筛选");
  searchInput.value = previous?.search || "";
  typeSelect.value = state.filters.type;
  statusSelect.value = state.filters.status;
  const resetBtn = button("清除筛选", {
    variant: "ghost",
    icon: "x",
    compact: true,
    onClick: () => resetFilters(),
  });

  const searchWrap = el(
    "div",
    { class: "ecm-search" },
    icon("search", 16),
    searchInput,
  );

  const filterbar = el(
    "div",
    { class: "ecm-filterbar" },
    searchWrap,
    typeSelect,
    statusSelect,
    groupSelect,
    resetBtn,
  );

  const messages = el("div", { class: "ecm-messages" });
  const batchCount = el("span", { class: "ecm-batch-count" }, "未选择站点");
  const batchEnableBtn = button("启用", {
    variant: "secondary",
    icon: "play",
    compact: true,
    disabled: true,
    onClick: () => runBatch("enable"),
  });
  const batchDisableBtn = button("停用", {
    variant: "secondary",
    icon: "square",
    compact: true,
    disabled: true,
    onClick: () => runBatch("disable"),
  });
  const batchBar = el(
    "div",
    { class: "ecm-batch", hidden: true },
    icon("check-circle", 16),
    batchCount,
    el("div", { class: "ecm-batch-actions" }, batchEnableBtn, batchDisableBtn),
  );

  const results = el("div", { class: "ecm-sites-results" });
  const scanNotice = el("div", { class: "ecm-scan-notice" });
  const content = el("div", { class: "ecm-stack" }, filterbar, scanNotice, messages, batchBar, results);
  root.append(el("div", { class: "ecm-page" }, header, content));

  let searchTimer = null;

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = searchInput.value.trim().toLowerCase();
      state.selected.clear();
      renderResults();
    }, 250);
  });
  typeSelect.addEventListener("change", () => {
    state.filters.type = typeSelect.value;
    state.selected.clear();
    renderResults();
  });
  statusSelect.addEventListener("change", () => {
    state.filters.status = statusSelect.value;
    state.selected.clear();
    renderResults();
  });
  groupSelect.addEventListener("change", () => {
    state.filters.group = groupSelect.value;
    state.selected.clear();
    renderResults();
  });

  function resetFilters() {
    state.filters = { q: "", type: "", status: "", group: "" };
    searchInput.value = "";
    typeSelect.value = "";
    statusSelect.value = "";
    groupSelect.value = "";
    state.selected.clear();
    renderResults();
  }

  function groupValues() {
    const set = new Set();
    for (const group of state.groups || []) {
      if (typeof group === "string" && group !== "") set.add(group);
    }
    for (const item of state.items) {
      if (item.group) set.add(item.group);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  function syncGroupOptions() {
    const current = state.filters.group;
    const values = groupValues();
    groupSelect.replaceChildren(
      el("option", { value: "" }, "全部分组"),
      el("option", { value: "__none" }, "未分组"),
      ...values.map((group) => el("option", { value: group }, group)),
    );
    if (current && current !== "__none" && values.includes(current)) groupSelect.value = current;
    else if (current === "__none") groupSelect.value = "__none";
    else groupSelect.value = "";
  }

  function filteredItems() {
    const { q, type, status, group } = state.filters;
    return state.items.filter((item) => {
      if (type && item.type !== type) return false;
      if (group === "__none") {
        if (item.group) return false;
      } else if (group && item.group !== group) {
        return false;
      }
      if (status === "enabled" && !(item.enabled && !item.orphan)) return false;
      if (status === "disabled" && (item.enabled || item.orphan)) return false;
      if (status === "custom" && !item.custom) return false;
      if (status === "orphan" && !item.orphan) return false;
      if (status === "conflict" && !item.conflict) return false;
      if (q) {
        const haystack = [item.name, item.slug, ...(Array.isArray(item.domains) ? item.domains : [])]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  function selectableItems(items) {
    return items.filter((item) => !item.orphan);
  }

  function updateBatchBar(items) {
    const selectable = selectableItems(items);
    for (const slug of Array.from(state.selected)) {
      if (!selectable.some((item) => item.slug === slug)) state.selected.delete(slug);
    }
    const count = state.selected.size;
    batchBar.hidden = count === 0;
    batchCount.textContent = count === 0 ? "未选择站点" : `已选择 ${count} 个站点`;
    batchEnableBtn.disabled = count === 0 || state.busy;
    batchDisableBtn.disabled = count === 0 || state.busy;
  }

  function toggleSelected(slug, checked) {
    if (checked) state.selected.add(slug);
    else state.selected.delete(slug);
    updateBatchBar(filteredItems());
    const visible = filteredItems();
    if (selectAllBox) {
      const selectable = selectableItems(visible);
      const selectedVisible = selectable.filter((item) => state.selected.has(item.slug)).length;
      selectAllBox.checked = selectable.length > 0 && selectedVisible === selectable.length;
      selectAllBox.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
    }
  }

  let selectAllBox = null;

  function statusCell(item) {
    const wrap = el("div", { class: "ecm-status-stack" });
    if (item.orphan) {
      wrap.append(badge("孤儿记录", "warning", { dot: true }));
    } else {
      wrap.append(badge(item.enabled ? "已启用" : "已停用", item.enabled ? "success" : "neutral", { dot: true }));
    }
    if (item.custom) wrap.append(badge("自定义", "info"));
    if (item.conflict) wrap.append(badge("冲突", "danger", { title: "片段同时存在于启用与停用目录" }));
    return wrap;
  }

  function certCell(item) {
    if (!item.cert) return el("span", { class: "ecm-muted" }, "—");
    const cert = item.cert;
    if (cert.error) {
      return badge("未知", "neutral", { title: cert.error });
    }
    return badge(fmtDays(cert.days), certTone(cert.days, cert.error), {
      title: cert.expiresAt ? `到期：${fmtDateTime(cert.expiresAt)}` : "",
    });
  }

  function actionButtons(item) {
    const wrap = el("div", { class: "ecm-row-actions" });
    if (item.orphan) {
      wrap.append(
        button("清理元数据", {
          variant: "ghost",
          icon: "trash",
          compact: true,
          ariaLabel: `清理孤儿记录 ${item.name}`,
          title: "清理元数据",
          onClick: () => deleteItem(item),
        }),
      );
      return wrap;
    }
    const url = item.enabled && !item.conflict && item.urls?.[0];
    if (url) {
      wrap.append(el("a", { class: "ecm-link", href: url, target: "_blank", rel: "noopener noreferrer" }, "打开站点"));
    }
    const actions = el("div", { class: "ecm-toolbar" },
      button(item.enabled ? "停用" : "启用", {
        variant: "ghost",
        icon: item.enabled ? "square" : "play",
        compact: true,
        onClick: () => toggleSite(item),
      }),
      button("删除", {
        variant: "ghost",
        icon: "trash",
        compact: true,
        onClick: () => deleteItem(item),
      }),
    );
    wrap.append(el("details", { class: "ecm-site-actions" }, el("summary", null, "更多操作"), actions));
    return wrap;
  }

  async function toggleSite(item) {
    if (state.busy) return;
    if (item.enabled) {
      const ok = await confirmDialog({
        title: "停用站点",
        message: `停用站点「${item.name}」？Caddy 将立即停止为 ${(item.domains || []).join("、") || "该站点"} 提供服务，直到重新启用。`,
        confirmLabel: "停用站点",
        danger: true,
      });
      if (!ok) return;
    }
    state.busy = true;
    renderResults();
    try {
      // Read the current file so an external edit is reported as a 409
      // instead of silently moving a changed snippet.
      const current = await api.site(item.slug);
      if (item.enabled) await api.disableSite(item.slug, current.raw);
      else await api.enableSite(item.slug, current.raw);
      toast(item.enabled ? "站点已停用。" : "站点已启用。", "success");
      state.selected.clear();
      state.busy = false;
      await load({ silent: true });
    } catch (error) {
      toast(error.message || "操作失败", "danger");
      showMessage(feedback(error.message || "操作失败", "danger", { details: error.details }));
      state.busy = false;
      renderResults();
    }
  }

  async function deleteItem(item) {
    if (state.busy) return;
    const metadataOnly = item.orphan;
    const label = metadataOnly ? "清理元数据" : "删除站点";
    try {
      const current = metadataOnly ? null : await api.site(item.slug);
      const ok = await confirmDialog({
        title: label,
        message: metadataOnly
          ? `清理「${item.name}」的站点元数据？磁盘上已不存在对应片段，站点目录会保留。`
          : `删除「${item.name}」的配置片段？站点目录会保留，可在备份中恢复片段。`,
        confirmLabel: label,
        danger: true,
      });
      if (!ok || state.busy || state.destroyed) return;
      state.busy = true;
      renderResults();
      await api.deleteSite(item.slug, current?.raw);
      toast(metadataOnly ? "孤儿元数据已清理。" : "站点配置已删除。", "success");
      state.busy = false;
      await load({ silent: true });
    } catch (error) {
      const message = error.message || `${label}失败`;
      toast(message, "danger");
      showMessage(feedback(message, "danger", { details: error.details }));
      state.busy = false;
      renderResults();
    }
  }

  async function runBatch(action) {
    if (state.busy || state.selected.size === 0) return;
    const slugs = Array.from(state.selected);
    if (action === "disable") {
      const ok = await confirmDialog({
        title: "批量停用站点",
        message: `停用选中的 ${slugs.length} 个站点？Caddy 将立即停止为这些站点提供服务；配置校验或重载失败时会自动回滚。`,
        confirmLabel: "停用站点",
        danger: true,
      });
      if (!ok) return;
    }
    state.busy = true;
    messages.replaceChildren();
    results.replaceChildren(loadingBlock(action === "enable" ? "正在启用站点…" : "正在停用站点…"));
    const errors = [];
    let completed = 0;
    for (const slug of slugs) {
      try {
        const current = await api.site(slug);
        if (action === "enable") await api.enableSite(slug, current.raw);
        else await api.disableSite(slug, current.raw);
      } catch (error) {
        errors.push({ slug, message: error.message || "操作失败" });
      }
      completed += 1;
    }
    state.busy = false;
    state.selected.clear();
    if (errors.length === 0) {
      toast(`${completed} 个站点已${action === "enable" ? "启用" : "停用"}。`, "success");
    } else {
      toast(`${completed - errors.length} 个成功，${errors.length} 个失败。`, "danger");
      const list = el("ul", { class: "ecm-error-list" });
      for (const error of errors.slice(0, 5)) {
        list.append(el("li", { class: "ecm-error-item" }, el("span", { class: "ecm-mono" }, error.slug), el("span", null, error.message)));
      }
      messages.replaceChildren(feedback(`部分站点操作失败：`, "danger", { details: null }));
      messages.firstElementChild.querySelector(".ecm-feedback-body").append(list);
    }
    await load({ silent: true, keepMessages: true });
  }

  function showMessage(node) {
    messages.replaceChildren(node);
  }

  function emptyForFilters() {
    return emptyState({
      title: "没有匹配的站点",
      icon: "search",
    });
  }

  function renderResults() {
    if (state.destroyed) return;
    syncGroupOptions();
    const visible = filteredItems();
    const empty = !state.loading && !state.error && state.items.length === 0;
    filterbar.hidden = state.items.length === 0;
    newBtn.hidden = empty;
    resetBtn.disabled = !Object.values(state.filters).some(Boolean);
    siteCount.hidden = state.items.length === 0 || Boolean(state.error);
    siteCount.textContent = `${state.items.length} 个站点`;
    updateBatchBar(visible);
    scanNotice.replaceChildren();
    if (state.warnings.length > 0) {
      const shown = state.warnings.slice(0, 3).join("；");
      const more = state.warnings.length > 3 ? `；另有 ${state.warnings.length - 3} 条` : "";
      scanNotice.append(
        feedback(`有 ${state.warnings.length} 个片段文件或元数据被忽略：${shown}${more}`, "warning"),
      );
    }

    if (state.loading) {
      results.replaceChildren(loadingBlock("正在读取站点…"));
      return;
    }
    if (state.error) {
      results.replaceChildren(
        errorBlock(state.error, {
          title: "站点列表加载失败",
          onRetry: () => load(),
        }),
      );
      return;
    }
    if (state.busy) {
      results.replaceChildren(loadingBlock("正在应用变更…"));
      return;
    }
    if (state.items.length === 0) {
      results.replaceChildren(
        emptyState({
          title: "还没有站点",
          icon: "globe",
          action: button("新建站点", {
            variant: "primary",
            icon: "plus",
            onClick: () => ctx.navigate("#/sites/new"),
          }),
        }),
      );
      return;
    }
    if (visible.length === 0) {
      results.replaceChildren(emptyForFilters());
      return;
    }

    selectAllBox = el("input", {
      type: "checkbox",
      class: "ecm-check-input",
      "aria-label": "全选当前列表",
    });
    const selectable = selectableItems(visible);
    const selectedVisible = selectable.filter((item) => state.selected.has(item.slug)).length;
    selectAllBox.checked = selectable.length > 0 && selectedVisible === selectable.length;
    selectAllBox.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
    selectAllBox.addEventListener("change", () => {
      const hadFocus = document.activeElement === selectAllBox;
      for (const item of selectable) {
        if (selectAllBox.checked) state.selected.add(item.slug);
        else state.selected.delete(item.slug);
      }
      updateBatchBar(filteredItems());
      renderResults();
      if (hadFocus) {
        requestAnimationFrame(() => {
          const next = results.querySelector('input[aria-label="全选当前列表"]');
          if (next) next.focus({ preventScroll: true });
        });
      }
    });

    const columns = [
      {
        key: "select",
        label: selectAllBox,
        width: "40px",
        render: (item) => {
          const box = el("input", {
            type: "checkbox",
            class: "ecm-check-input",
            checked: state.selected.has(item.slug),
            disabled: item.orphan,
            "aria-label": `选择站点 ${item.name}`,
            title: item.orphan ? "孤儿记录不能批量操作" : "",
          });
          box.addEventListener("change", () => toggleSelected(item.slug, box.checked));
          return el("label", { class: "ecm-check ecm-check-tight" }, box, el("span", { class: "ecm-check-box", "aria-hidden": "true" }, icon("check", 12)));
        },
      },
      { key: "status", label: "状态", render: (item) => statusCell(item) },
      {
        key: "name",
        label: "名称",
        render: (item) =>
          el(
            "div",
            { class: "ecm-row-title-wrap" },
            el("a", { class: "ecm-link ecm-row-title", href: `#/sites/${encodeURIComponent(item.slug)}` }, item.name || item.slug),
            el("span", { class: "ecm-hint ecm-mono" }, item.slug),
          ),
      },
      {
        key: "domains",
        label: "访问地址",
        render: (item) => {
          const domains = item.urls?.length && !item.conflict ? item.urls : item.domains || [];
          if (domains.length === 0) {
            return el("span", { class: "ecm-muted" }, item.orphan ? "无片段" : "—");
          }
          return chips(domains, { mono: true, limit: 2 });
        },
      },
      {
        key: "type",
        label: "类型",
        hideBelow: "sm",
        render: (item) => typeLabel(item.type),
      },
      {
        key: "group",
        label: "分组",
        hideBelow: "md",
        render: (item) => item.group || "—",
      },
      {
        key: "cert",
        label: "证书",
        hideBelow: "sm",
        render: (item) => certCell(item),
      },
      {
        key: "updated",
        label: "更新",
        hideBelow: "md",
        render: (item) =>
          item.updatedAt
            ? el("span", { title: fmtDateTime(item.updatedAt, { seconds: true }) }, fmtRelative(item.updatedAt))
            : "—",
      },
      { key: "actions", label: "操作", align: "right", render: (item) => actionButtons(item) },
    ];

    results.replaceChildren(
      el(
        "div",
        { class: "ecm-card ecm-card-flush" },
        dataTable({
          label: "站点列表",
          columns,
          rows: visible,
          onRowClick: (item) => ctx.navigate(`#/sites/${encodeURIComponent(item.slug)}`),
          getRowAriaLabel: (item) => `打开站点 ${item.name}`,
          rowClass: (item) => (item.orphan ? "is-orphan" : ""),
        }),
      ),
    );
  }

  async function load(opts = {}) {
    if (state.destroyed) return;
    if (!opts.silent) {
      state.loading = true;
      state.error = null;
      renderResults();
    }
    refreshBtn.disabled = true;
    try {
      const data = await api.sites();
      if (state.destroyed) return;
      state.items = Array.isArray(data && data.items) ? data.items : [];
      state.groups = Array.isArray(data && data.groups) ? data.groups : [];
      state.warnings = Array.isArray(data && data.warnings) ? data.warnings : [];
      state.error = null;
      if (!opts.keepMessages) messages.replaceChildren();
      for (const slug of Array.from(state.selected)) {
        if (!state.items.some((item) => item.slug === slug && !item.orphan)) state.selected.delete(slug);
      }
    } catch (error) {
      if (state.destroyed) return;
      if (opts.silent) {
        showMessage(feedback(error.message || "站点列表刷新失败", "danger", { details: error.details }));
      } else {
        state.error = error;
      }
    } finally {
      state.loading = false;
      state.busy = false;
      refreshBtn.disabled = false;
      renderResults();
    }
  }

  await load();

  return {
    scrollTop: previous?.scrollTop ?? 0,
    destroy() {
      previousList = {
        filters: { ...state.filters, q: searchInput.value.trim().toLowerCase() },
        search: searchInput.value,
        scrollTop: window.scrollY,
      };
      state.destroyed = true;
      clearTimeout(searchTimer);
    },
  };
}
