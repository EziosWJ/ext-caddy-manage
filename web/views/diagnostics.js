import api from "../api.js";
import {
  badge,
  button,
  buttonBusy,
  chips,
  confirmDialog,
  dataTable,
  el,
  emptyState,
  errorBlock,
  feedback,
  formatDetails,
  icon,
  loadingBlock,
  metaGrid,
  pageHeader,
  section,
  statTile,
  toast,
} from "../components.js";
import { fmtBytes } from "../format.js";

const STATUS_META = {
  ok: { label: "正常", tone: "success", icon: "check-circle", className: "is-ok" },
  warn: { label: "警告", tone: "warning", icon: "alert-triangle", className: "is-warn" },
  error: { label: "错误", tone: "danger", icon: "x-circle", className: "is-error" },
  unknown: { label: "未知", tone: "neutral", icon: "help-circle", className: "is-unknown" },
};

const MODULE_OPTIONAL = [
  { key: "l4", label: "l4 四层代理" },
  { key: "ratelimit", label: "ratelimit 限流" },
  { key: "dns", label: "DNS-01 提供商" },
];

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.unknown;
}

export async function mount(root, ctx) {
  const page = el("div", { class: "ecm-page" });
  root.append(page);

  let data = null;
  let destroyed = false;
  let moduleQuery = "";

  const refreshBtn = button("重新检测", {
    variant: "primary",
    icon: "refresh-cw",
    onClick: () => load(),
  });
  const initBtn = button("生成初始配置", {
    variant: "secondary",
    icon: "file-plus",
    onClick: () => initConfig(initBtn),
  });

  const header = pageHeader({
    title: "诊断",
    subtitle: "检查 Caddy 二进制、目录、权限、服务授权与整体配置。",
    backHref: "#/overview",
    backLabel: "概览",
    actions: [refreshBtn, initBtn],
  });
  const content = el("div", { class: "ecm-stack" });
  page.append(header, content);

  function buildSummary(summary) {
    const s = summary || {};
    const tiles = el("div", { class: "ecm-tiles" });
    tiles.append(
      statTile({ label: "正常", value: s.ok ?? 0, tone: "success", icon: "check-circle" }),
      statTile({ label: "警告", value: s.warn ?? 0, tone: "warning", icon: "alert-triangle" }),
      statTile({ label: "错误", value: s.error ?? 0, tone: "danger", icon: "x-circle" }),
      statTile({ label: "未知", value: s.unknown ?? 0, tone: "neutral", icon: "help-circle" }),
    );
    return section({ title: "检查摘要", children: tiles });
  }

  function buildChecklist(items) {
    const card = section({
      title: "检查清单",
      description: "每一项都来自实时读取或 Caddy 命令输出；详细信息可展开查看。",
      children: [],
    });
    const body = card.querySelector(".ecm-card-body");
    if (!Array.isArray(items) || items.length === 0) {
      body.append(emptyState({ title: "没有检查结果", body: "重新检测后再试。", icon: "activity" }));
      return card;
    }
    const list = el("ul", { class: "ecm-checklist" });
    for (const item of items) {
      const meta = statusMeta(item.status);
      const row = el("li", { class: `ecm-checkitem ${meta.className}` });
      row.append(el("span", { class: "ecm-checkitem-icon", "aria-hidden": "true" }, icon(meta.icon, 18)));
      const main = el("div", { class: "ecm-checkitem-main" });
      const head = el(
        "div",
        { class: "ecm-checkitem-head" },
        el("span", { class: "ecm-checkitem-label" }, item.label || item.key || "检查项"),
        badge(meta.label, meta.tone),
      );
      main.append(head);
      if (item.message) main.append(el("p", { class: "ecm-checkitem-message" }, item.message));
      if (item.details && typeof item.details === "object" && Object.keys(item.details).length > 0) {
        const pre = el("pre", { class: "ecm-pre ecm-pre-sm" });
        pre.textContent = formatDetails(item.details);
        main.append(
          el("details", { class: "ecm-details ecm-details-inline" }, el("summary", null, "详细信息"), pre),
        );
      }
      row.append(main);
      list.append(row);
    }
    body.append(list);
    return card;
  }

  function buildConfigCard(config) {
    const rows = Array.isArray(config) ? config : [];
    const card = section({ title: "生效配置", children: [], flush: true });
    const body = card.querySelector(".ecm-card-body");
    if (rows.length === 0) {
      body.append(el("p", { class: "ecm-hint ecm-card-pad" }, "没有可显示的配置。"));
      return card;
    }
    body.append(
      dataTable({
        label: "生效配置",
        columns: [
          { key: "label", label: "配置项", render: (row) => row.label || row.key },
          { key: "value", label: "生效值", mono: true },
        ],
        rows,
        getRowAriaLabel: (row) => row.label || row.key,
      }),
    );
    return card;
  }

  function buildPathsCard(paths) {
    const p = paths || {};
    return section({
      title: "路径",
      children: metaGrid([
        { label: "Caddy 可执行文件", value: p.caddyBinary || "—", mono: true },
        { label: "主 Caddyfile", value: p.mainConfig || "—", mono: true },
        { label: "站点片段目录", value: p.snippetDir || "—", mono: true },
        { label: "停用片段目录", value: p.disabledDir || "—", mono: true },
        { label: "站点根目录", value: p.sitesRoot || "—", mono: true },
        { label: "备份目录", value: p.backupsDir || "—", mono: true },
      ]),
    });
  }

  function buildModulesCard(modules) {
    const mods = modules || {};
    const items = Array.isArray(mods.items) ? mods.items : [];
    const optional = mods.optional && typeof mods.optional === "object" ? mods.optional : {};
    const card = section({
      title: "Caddy 模块",
      actions: mods.truncated ? badge("输出已截断", "warning") : badge(`${items.length} 个`, "neutral"),
      children: [],
    });
    const body = card.querySelector(".ecm-card-body");

    if (mods.truncated) {
      body.append(feedback("list-modules 输出被截断，模块列表可能不完整。", "warning"));
    }

    const optionRow = el("div", { class: "ecm-inline ecm-wrap ecm-optional-modules" });
    for (const option of MODULE_OPTIONAL) {
      const present = Boolean(optional[option.key]);
      optionRow.append(
        el(
          "span",
          { class: `ecm-chip ${present ? "ecm-chip-success" : ""}` },
          el("span", { class: `ecm-dot ecm-dot-${present ? "success" : "neutral"}`, "aria-hidden": "true" }),
          el("span", null, option.label),
          el("span", { class: "ecm-muted" }, present ? "已检测到" : "未检测到"),
        ),
      );
    }
    body.append(optionRow);

    if (items.length === 0) {
      body.append(emptyState({ title: "没有模块信息", body: "Caddy 模块列表为空，或命令执行失败。", icon: "database" }));
      return card;
    }

    const filterInput = el("input", {
      class: "ecm-control ecm-search-input",
      type: "search",
      placeholder: "过滤模块名称",
      "aria-label": "过滤模块",
      autocomplete: "off",
    });
    filterInput.value = moduleQuery;
    const list = el("div", { class: "ecm-module-list", role: "list" });
    const count = el("p", { class: "ecm-hint" });
    const renderModules = () => {
      moduleQuery = filterInput.value.trim().toLowerCase();
      const filtered = items.filter((name) => String(name).toLowerCase().includes(moduleQuery));
      list.replaceChildren();
      if (filtered.length === 0) {
        list.append(el("p", { class: "ecm-hint" }, "没有匹配的模块。"));
      } else {
        for (const name of filtered) {
          list.append(el("code", { class: "ecm-chain ecm-mono", role: "listitem" }, String(name)));
        }
      }
      count.textContent = `显示 ${filtered.length} / ${items.length} 个模块。`;
    };
    filterInput.addEventListener("input", renderModules);
    renderModules();
    body.append(
      el("div", { class: "ecm-search ecm-search-block" }, icon("search", 16), filterInput),
      count,
      list,
    );
    return card;
  }

  function buildValidateCard(validate) {
    const card = section({
      title: "整体配置校验",
      description: "调用 caddy validate --adapter caddyfile 校验当前主配置及其 import。",
      children: [],
    });
    const body = card.querySelector(".ecm-card-body");
    const resultArea = el("div", { class: "ecm-messages" });
    const initial = validate && typeof validate === "object" ? validate : null;
    const showResult = (ok, message, details) => {
      resultArea.replaceChildren(
        feedback(message || (ok ? "配置有效。" : "配置校验失败。"), ok ? "success" : "danger", {
          details: details || null,
        }),
      );
    };
    if (initial) showResult(Boolean(initial.ok), initial.message || (initial.ok ? "配置有效。" : "配置校验失败。"));
    const validateBtn = button("校验当前配置", {
      variant: "secondary",
      icon: "check-circle",
      onClick: async () => {
        buttonBusy(validateBtn, true, "校验中…");
        resultArea.replaceChildren(loadingBlock("正在校验配置…"));
        try {
          const result = await api.validateCurrent();
          showResult(true, result && result.source === "current" ? "当前主配置校验通过。" : "配置校验通过。");
          toast("当前主配置校验通过。", "success");
        } catch (error) {
          showResult(false, error.message || "配置校验失败。", error.details);
        } finally {
          if (validateBtn.isConnected) buttonBusy(validateBtn, false);
        }
      },
    });
    body.append(el("div", { class: "ecm-toolbar" }, validateBtn), resultArea);
    return card;
  }

  function render() {
    if (!data) return;
    content.replaceChildren();
    content.append(buildSummary(data.summary));
    content.append(buildChecklist(data.items));

    const grid = el("div", { class: "ecm-diag-grid" });
    grid.append(buildConfigCard(data.config));
    grid.append(buildPathsCard(data.paths));
    content.append(grid);
    content.append(buildModulesCard(data.modules));
    content.append(buildValidateCard(data.validate));

    if (data.caddy && data.caddy.version) {
      header.querySelector(".ecm-page-sub").textContent =
        `检测到 Caddy ${data.caddy.version}；检查 Caddy 二进制、目录、权限、服务授权与整体配置。`;
    }
    ctx.setTitle("诊断");
  }

  async function load() {
    refreshBtn.disabled = true;
    content.replaceChildren(loadingBlock("正在执行诊断…"));
    try {
      const result = await api.diagnostics();
      if (destroyed) return;
      data = result || {};
      render();
    } catch (error) {
      if (destroyed) return;
      content.replaceChildren(
        errorBlock(error, { title: "诊断加载失败", onRetry: () => load() }),
      );
    } finally {
      if (!destroyed) refreshBtn.disabled = false;
    }
  }

  async function initConfig(btn) {
    const initialized = Boolean(data && data.initialized);
    const mainPath = (data && data.paths && data.paths.mainConfig) || "主 Caddyfile";
    const ok = await confirmDialog({
      title: "生成初始配置",
      message: initialized
        ? [
            `主 Caddyfile 已存在：${mainPath}`,
            el(
              "p",
              { class: "ecm-dialog-emphasis" },
              "生成初始配置会覆盖现有文件内容（覆盖前自动备份），写入受管全局块与 import 行，并触发整体校验与重载。",
            ),
          ]
        : `将创建缺失的目录并写入初始主 Caddyfile：${mainPath}。生成后会执行整体配置校验。`,
      confirmLabel: initialized ? "覆盖并生成" : "生成初始配置",
      danger: initialized,
    });
    if (!ok) return;
    buttonBusy(btn, true, "生成中…");
    try {
      const result = await api.initConfig(initialized);
      toast(
        result && result.written === false
          ? "主配置已存在且非空，未写入。"
          : "初始配置已写入。",
        result && result.written === false ? "warning" : "success",
      );
      await load();
      if (typeof ctx.refreshHealth === "function") ctx.refreshHealth();
    } catch (error) {
      toast(error.message || "生成初始配置失败", "danger");
      if (error.code === "conflict") {
        content.prepend(
          feedback(error.message || "主 Caddyfile 已存在且非空，需要确认覆盖。", "warning", {
            details: error.details,
          }),
        );
        const force = await confirmDialog({
          title: "覆盖现有主 Caddyfile？",
          message: [
            error.message || "主 Caddyfile 已存在且非空。",
            el(
              "p",
              { class: "ecm-dialog-emphasis" },
              "覆盖前会自动备份当前文件；覆盖后写入初始配置并校验。",
            ),
          ],
          confirmLabel: "覆盖并生成",
          danger: true,
        });
        if (force) {
          try {
            await api.initConfig(true);
            toast("已覆盖并生成初始配置。", "success");
            await load();
            if (typeof ctx.refreshHealth === "function") ctx.refreshHealth();
          } catch (retryError) {
            toast(retryError.message || "生成初始配置失败", "danger");
            content.prepend(
              feedback(retryError.message || "生成初始配置失败", "danger", {
                details: retryError.details,
              }),
            );
          }
        }
      } else {
        content.prepend(
          feedback(error.message || "生成初始配置失败", "danger", { details: error.details }),
        );
      }
    } finally {
      if (btn.isConnected) buttonBusy(btn, false);
    }
  }

  await load();

  return {
    destroy() {
      destroyed = true;
    },
  };
}
