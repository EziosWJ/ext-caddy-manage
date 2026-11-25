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
  linkButton,
  selectField,
  metaGrid,
  pageHeader,
  section,
  statTile,
  toast,
} from "../components.js";
import { fmtBytes, fmtDateTime } from "../format.js";

const STATUS_META = {
  ok: { label: "正常", tone: "success", icon: "check-circle", className: "is-ok" },
  warn: { label: "警告", tone: "warning", icon: "alert-triangle", className: "is-warn" },
  error: { label: "错误", tone: "danger", icon: "x-circle", className: "is-error" },
  unknown: { label: "未知", tone: "neutral", icon: "help-circle", className: "is-unknown" },
};

const MODULE_OPTIONAL = [
  { key: "l4", label: "l4 四层代理" },
  { key: "ratelimit", label: "ratelimit 限流" },
];

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.unknown;
}

const SITE_STAGES = {
  dns: "宿主 DNS", listen: "监听及端口归属", tls: "TLS、SNI 和信任",
  upstream: "上游连通", http: "HTTP 响应", config: "磁盘配置",
};

function siteCheckCard(preselected) {
  const resultArea = el("div", { class: "ecm-stack", "aria-live": "polite" });
  const selection = selectField({ label: "站点", options: [], value: "" });
  const entry = selectField({ label: "访问入口", options: [], value: "" });
  const run = button("执行链路检查", { variant: "primary", icon: "activity", disabled: true, onClick: check });
  const controls = el("div", { class: "ecm-stack" },
    el("div", { class: "ecm-diag-grid" }, selection.root, entry.root),
    el("div", { class: "ecm-toolbar" }, run),
    resultArea,
  );
  const card = section({
    title: "检查站点",
    help: "从 Extension Host 所在机器检查已配置入口。HTTP 检查发送 HEAD /，入口连接固定到本机监听并保留域名或 IP 身份。",
    children: controls,
  });
  const bySlug = new Map();

  function updateEntries() {
    const site = bySlug.get(selection.control.value);
    const addresses = site?.domains || [];
    const options = addresses.map((domain, index) => ({
      value: String(index + 1),
      label: site.urls?.length === addresses.length ? site.urls[index] : domain,
    }));
    if (!options.length) options.push({ value: "1", label: "仅检查配置" });
    entry.control.replaceChildren(...options.map(({ value, label }) => el("option", { value }, label)));
    entry.control.disabled = !site || options.length === 1;
    run.disabled = !site;
    resultArea.replaceChildren();
  }

  selection.control.addEventListener("change", updateEntries);
  entry.control.addEventListener("change", () => resultArea.replaceChildren());

  async function loadSites() {
    resultArea.replaceChildren(loadingBlock("正在读取站点…"));
    selection.control.disabled = true;
    entry.control.disabled = true;
    try {
      const { items } = await api.sites();
      for (const site of items) bySlug.set(site.slug, site);
      selection.control.replaceChildren(
        el("option", { value: "" }, "选择站点"),
        ...items.map((site) => el("option", { value: site.slug }, site.name || site.slug)),
      );
      selection.control.disabled = !items.length;
      if (bySlug.has(preselected)) selection.control.value = preselected;
      updateEntries();
      if (!items.length) resultArea.append(feedback("请先创建站点，再执行链路检查。", "info", {
        action: linkButton("新建站点", "#/sites/new", { compact: true }),
      }));
    } catch (error) {
      resultArea.replaceChildren(errorBlock(error, { title: "读取站点失败", onRetry: loadSites }));
    }
  }

  async function check() {
    const slug = selection.control.value;
    buttonBusy(run, true, "检查中…");
    selection.control.disabled = true;
    entry.control.disabled = true;
    resultArea.replaceChildren(loadingBlock("正在检查站点链路…"));
    try {
      const result = await api.siteCheck(slug, Number(entry.control.value));
      const siteHref = `#/sites/${encodeURIComponent(slug)}`;
      const next = {
        site: ["查看站点配置", siteHref],
        tls: ["查看证书与信任指引", `${siteHref}?section=tls`],
        global: ["查看全局配置", "#/global"],
      };
      const actionFor = (step) => {
        const action = next[step.action];
        return action ? linkButton(action[0], action[1], { compact: true }) : null;
      };
      const first = result.steps.find((step) => step.id === result.firstFailure)
        || result.steps.find((step) => step.status === "unknown");
      resultArea.replaceChildren(metaGrid([
        { label: "检查时间（宿主视角）", value: fmtDateTime(result.checkedAt, { seconds: true }) },
        { label: "访问入口", value: result.url, mono: true },
        { label: "本机探测目标", value: result.target, mono: true },
      ]));
      if (first) {
        const tone = first.status === "error" ? "danger" : "warning";
        const prefix = first.status === "error" ? "优先处理" : "待确认";
        resultArea.append(feedback(`${prefix} · ${SITE_STAGES[first.id]}。 ${first.message}`, tone, { action: actionFor(first) }));
      }
      const steps = el("ol", { class: "ecm-checklist" });
      for (const step of result.steps) {
        const info = step.status === "skipped" ? { label: "已跳过", tone: "neutral", icon: "minus", className: "is-unknown" }
          : statusMeta(step.status);
        steps.append(el("li", { class: `ecm-checkitem ${info.className}` },
          el("span", { class: "ecm-checkitem-icon", "aria-hidden": "true" }, icon(info.icon, 18)),
          el("div", { class: "ecm-checkitem-main" },
            el("div", { class: "ecm-checkitem-head" }, SITE_STAGES[step.id], badge(info.label, info.tone)),
            el("p", { class: "ecm-checkitem-message" }, step.message),
            step !== first ? actionFor(step) : null,
            step.output ? el("details", { class: "ecm-details ecm-details-inline" },
              el("summary", null, "原始输出"), el("pre", { class: "ecm-pre ecm-pre-sm" }, step.output)) : null,
          ),
        ));
      }
      resultArea.append(steps);
    } catch (error) {
      resultArea.replaceChildren(feedback(error.message || "站点检查失败。", "danger"));
    } finally {
      selection.control.disabled = false;
      entry.control.disabled = entry.control.options.length === 1;
      buttonBusy(run, false);
      if (run.isConnected && document.activeElement === document.body) run.focus();
    }
  }

  loadSites();
  return card;
}

export async function mount(root, ctx, route) {
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
    backHref: "#/overview",
    backLabel: "概览",
    actions: [refreshBtn, initBtn],
  });
  const content = el("div", { class: "ecm-stack" });
  page.append(header, siteCheckCard(route.slug), content);

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

  function buildDnsCard(dns) {
    const stateLabels = {
      installed: ["已安装", "success"],
      missing: ["未安装", "warning"],
      unknown: ["无法确认", "neutral"],
    };
    function moduleStatus(value) {
      const [label, tone] = stateLabels[value] || stateLabels.unknown;
      return badge(label, tone, { dot: true });
    }
    const build = {
      same: "磁盘二进制与服务进程的可执行文件一致。",
      different: "服务进程使用不同构建。请确认 systemd 的 ExecStart 并核对运行构建。",
      unknown: "未能读取或比较服务进程的可执行文件。请管理员核对服务的 MainPID 和磁盘二进制。",
    };
    return section({
      title: "DNS-01 提供商",
      children: el("div", { class: "ecm-stack" },
        el("p", { class: "ecm-hint" }, build[dns.runningBuild] || build.unknown),
        dataTable({
          label: "DNS-01 模块检测",
          columns: [
            { key: "id", label: "模块 ID", mono: true },
            { key: "disk", label: "磁盘构建", render: (row) => moduleStatus(row.disk) },
            { key: "running", label: "运行构建", render: (row) => moduleStatus(row.running) },
          ],
          rows: dns.providers || [],
        }),
        el("details", { class: "ecm-details" },
          el("summary", null, "部署与验收"),
          el("div", { class: "ecm-details-body ecm-stack" },
            el("p", null, "优先验证 Cloudflare。管理员用固定版本的 xcaddy、Caddy 和 provider 构建二进制，并限制令牌只能管理指定区域的 DNS。"),
            el("p", null, "将凭据放在受保护的服务环境文件中。Caddyfile 通过 {env.CLOUDFLARE_API_TOKEN} 引用。启动参数去掉 --environ，避免把服务环境写进日志。"),
            el("p", null, "先校验配置，再测试服务装载及回滚。用 ACME staging 验证签发和续期。通配符用具体子域名探测，根域单独签发并验证。"),
            el("a", {
              class: "ecm-link",
              href: "https://github.com/EziosWJ/ext-caddy-manage/blob/main/deploy/README.md",
              target: "_blank",
              rel: "noopener noreferrer",
            }, "部署手册"),
          ),
        ),
      ),
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
      help: "校验主 Caddyfile 及其导入的片段。",
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
    content.append(buildDnsCard(data.dns || {}), buildModulesCard(data.modules));
    content.append(buildValidateCard(data.validate));

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
