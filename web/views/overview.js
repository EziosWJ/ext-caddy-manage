import api from "../api.js";
import {
  badge,
  button,
  buttonBusy,
  dataTable,
  emptyState,
  errorBlock,
  feedback,
  helpTip,
  icon,
  linkButton,
  loadingBlock,
  logViewer,
  metaGrid,
  openDialog,
  pageHeader,
  section,
  statTile,
  toast,
  confirmDialog,
  el,
} from "../components.js";
import {
  certTone,
  fmtBytes,
  fmtCpuTime,
  fmtDateTime,
  fmtDays,
  fmtDurationMs,
  fmtRelative,
  statusLabel,
  statusTone,
} from "../format.js";

const SNAPSHOT_STATUS = {
  uncollected: ["未采集", "neutral"],
  ok: ["已采集", "success"],
  expired: ["已过期", "warning"],
  unreachable: ["不可达", "danger"],
  unavailable: ["不可用", "warning"],
  truncated: ["已截断", "warning"],
};

function bootStateLabel(value) {
  switch (value) {
    case "enabled":
      return "已设为开机启动";
    case "disabled":
      return "未设为开机启动";
    case "static":
      return "静态单元";
    default:
      return value || "—";
  }
}

function scopeLabel(scope) {
  switch (scope) {
    case "service":
      return "服务";
    case "apply":
      return "应用";
    case "certs":
      return "证书";
    case "global":
      return "全局";
    case "logs":
      return "日志";
    case "backup":
      return "备份";
    case "diagnostics":
      return "诊断";
    default:
      return scope || "系统";
  }
}

export async function mount(root, ctx) {
  const refreshBtn = button("", {
    variant: "ghost",
    icon: "refresh-cw",
    compact: true,
    ariaLabel: "刷新概览",
    title: "刷新",
    onClick: () => load(),
  });
  const logBtn = button("服务日志", {
    variant: "secondary",
    icon: "terminal",
    onClick: () => openLogDrawer(),
  });
  const newSiteBtn = linkButton("新建站点", "#/sites/new", {
    variant: "primary",
    icon: "plus",
  });

  const header = pageHeader({
    title: "概览",
    actions: [refreshBtn, logBtn, newSiteBtn],
  });
  const content = el("div", { class: "ecm-stack" });
  root.append(el("div", { class: "ecm-page" }, header, content));

  let data = null;
  let destroyed = false;
  let drawer = null;
  let drawerViewer = null;
  let snapshotTimer = null;
  const snapshotStatus = el("span", { "aria-live": "polite" });
  const snapshotBody = el("div", { class: "ecm-stack" });
  const collectBtn = button("采集运行快照", {
    compact: true, icon: "refresh-cw", onClick: () => loadSnapshot(true),
  });
  const snapshotCard = section({
    title: "Caddy 运行快照", actions: [snapshotStatus, collectBtn], children: snapshotBody,
  });

  function renderSnapshot(snapshot) {
    const [label, tone] = SNAPSHOT_STATUS[snapshot.status] || SNAPSHOT_STATUS.unavailable;
    snapshotStatus.replaceChildren(badge(label, tone, { dot: true }));
    const period = snapshot.periodSeconds ? `每 ${snapshot.periodSeconds} 秒采集`
      : snapshot.scheduleUnavailable ? "周期采集不可用" : "周期采集已关闭";
    const timestamp = snapshot.checkedAt ? `更新于 ${fmtDateTime(snapshot.checkedAt, { seconds: true })} · ` : "";
    snapshotBody.replaceChildren(el("p", { class: "ecm-hint" }, timestamp + period));
    if (snapshot.status === "expired") {
      snapshotBody.append(feedback("这份快照已过期。请重新采集以确认当前状态。", "warning"));
    }
    if (snapshot.message) snapshotBody.append(feedback(snapshot.message, "warning"));
    if (snapshot.status === "uncollected") {
      snapshotBody.append(el("p", { class: "ecm-hint" }, "按「采集运行快照」读取本机 Caddy Metrics。"));
    }
    if (snapshot.runtime && Object.keys(snapshot.runtime).length) {
      const runtime = snapshot.runtime;
      snapshotBody.append(metaGrid([
        { label: "Caddy RSS", value: fmtBytes(runtime.rssBytes) },
        { label: "Go 堆已分配", value: fmtBytes(runtime.heapBytes) },
        { label: "Goroutine", value: runtime.goroutines },
        { label: "进程 CPU 时间", value: runtime.cpuSeconds == null ? "—" : `${runtime.cpuSeconds.toFixed(2)} 秒` },
        { label: "进程启动", value: runtime.startedAt ? fmtDateTime(runtime.startedAt * 1000, { seconds: true }) : "—" },
      ]));
    }
    if (!snapshot.handlers) return;
    const handlersBlock = el(
      "div",
      { class: "ecm-snapshot-sub" },
      el("h3", { class: "ecm-subtitle" }, "HTTP 处理器"),
      el("p", { class: "ecm-hint" }, "按 Caddy server 与 handler 汇总累计样本。同一请求可能经过多个处理器。平均耗时和 HTTP 5xx 来自响应耗时样本，中间件错误来自单独的计数器。"),
    );
    if (snapshot.handlers.length) {
      handlersBlock.append(dataTable({
        label: "HTTP 处理器指标",
        columns: [
          { key: "server", label: "Server", mono: true },
          { key: "handler", label: "处理器", mono: true },
          { key: "requests", label: "处理次数", align: "right" },
          { key: "meanMs", label: "平均耗时", render: (row) => fmtDurationMs(row.meanMs) },
          { key: "http5xx", label: "HTTP 5xx", align: "right" },
          { key: "errors", label: "中间件错误", align: "right" },
        ],
        rows: snapshot.handlers,
      }));
    } else {
      handlersBlock.append(el("p", { class: "ecm-hint" }, "暂无 HTTP 处理器样本。可在全局配置中确认已启用 metrics，并访问站点后重新采集。"));
    }
    snapshotBody.append(handlersBlock);

    const upstreamsBlock = el(
      "div",
      { class: "ecm-snapshot-sub" },
      el("h3", { class: "ecm-subtitle" }, "上游状态"),
      el("p", { class: "ecm-hint" }, "Caddy 报告可选的上游仍需单独确认连通。"),
    );
    if (!snapshot.upstreams.length) {
      upstreamsBlock.append(el("p", { class: "ecm-hint" }, "没有上游健康样本。可在站点诊断中检查上游连通。"));
    } else {
      const grid = el("div", { class: "ecm-upstream-grid" });
      for (const upstream of snapshot.upstreams) {
        const unhealthy = upstream.status === "unhealthy";
        grid.append(el("div", { class: "ecm-upstream-pill" },
          el("code", { class: "ecm-mono" }, upstream.address),
          badge(unhealthy ? "Caddy 报告不健康" : "Caddy 可选 · 连通未验证", unhealthy ? "warning" : "neutral", { dot: true }),
        ));
      }
      upstreamsBlock.append(grid);
    }
    snapshotBody.append(upstreamsBlock);
  }

  let snapshotLoading = false;
  async function loadSnapshot(refresh = false) {
    if (snapshotLoading || destroyed) return;
    snapshotLoading = true;
    clearTimeout(snapshotTimer);
    if (refresh) buttonBusy(collectBtn, true, "采集中…");
    try {
      const snapshot = await api.metrics(refresh);
      if (destroyed) return;
      renderSnapshot(snapshot);
      if (snapshot.periodSeconds) {
        snapshotTimer = setTimeout(() => loadSnapshot(), 15000);
      } else if (snapshot.expiresIn > 0) {
        snapshotTimer = setTimeout(() => loadSnapshot(), (snapshot.expiresIn + 1) * 1000);
      }
    } catch (error) {
      if (!destroyed) renderSnapshot({ status: "unavailable", message: error.message });
    } finally {
      snapshotLoading = false;
      if (refresh) {
        buttonBusy(collectBtn, false);
        if (!destroyed && document.activeElement === document.body) collectBtn.focus();
      }
    }
  }


  function openLogDrawer() {
    if (drawer) {
      drawer.dialog.focus();
      return;
    }
    const unit = (data && data.service && data.service.unit) || "caddy.service";
    const viewer = logViewer({ scope: "service", defaultLines: Number(data && data.logLines) || 500 });
    drawerViewer = viewer;
    const handle = openDialog({
      title: `服务日志 · ${unit}`,
      body: viewer.root,
      drawer: true,
      className: "ecm-log-dialog",
      actions: [],
      onClose: () => {
        if (drawerViewer) {
          drawerViewer.destroy();
          drawerViewer = null;
        }
        drawer = null;
      },
    });
    drawer = handle;
    viewer.start();
  }

  async function runServiceAction(action, btn) {
    const labels = { start: "启动", stop: "停止", restart: "重启", reload: "重载" };
    if (action === "stop") {
      const ok = await confirmDialog({
        title: "停止 Caddy 服务",
        message: "停止后所有站点将立即停止响应，直到再次启动服务。",
        confirmLabel: "停止服务",
        danger: true,
      });
      if (!ok) return;
    }
    if (action === "restart") {
      const ok = await confirmDialog({
        title: "重启 Caddy 服务",
        message: "重启期间所有站点会短暂中断，通常持续数秒。",
        confirmLabel: "重启服务",
        danger: true,
      });
      if (!ok) return;
    }

    buttonBusy(btn, true, `${labels[action] || "处理"}中…`);
    try {
      const result = await api.serviceAction(action);
      const message =
        action === "reload" && result && result.reload && result.reload.ok
          ? "配置校验并重载成功。"
          : `${labels[action] || "操作"}成功。`;
      toast(message, "success");
      await load({ silent: true });
    } catch (error) {
      toast(error.message || `${labels[action] || "操作"}失败`, "danger");
      if (data) render();
      if (error.details) {
        content.prepend(feedback(error.message || "服务操作失败", "danger", { details: error.details }));
      }
    } finally {
      if (!destroyed) buttonBusy(btn, false);
    }
  }

  function renderService(service) {
    const svc = service || {};
    const available = svc.available !== false && !svc.error;
    const running = Boolean(svc.running);
    const tone = svc.error ? "warning" : statusTone(svc.state);
    const unitDetails = [svc.fragmentPath, svc.stateDetail].filter(Boolean).join("\n");

    const startBtn = button("启动", {
      variant: running ? "secondary" : "primary",
      icon: "play",
      compact: true,
      disabled: !available || running,
      onClick: () => runServiceAction("start", startBtn),
    });
    const reloadBtn = button("重载配置", {
      variant: running ? "soft" : "secondary",
      icon: "zap",
      compact: true,
      disabled: !available || !running,
      title: "校验主配置并让 Caddy 无缝重载",
      onClick: () => runServiceAction("reload", reloadBtn),
    });
    const restartBtn = button("重启", {
      variant: "ghost",
      icon: "rotate-cw",
      compact: true,
      disabled: !available,
      onClick: () => runServiceAction("restart", restartBtn),
    });
    const stopBtn = button("停止", {
      variant: "danger-ghost",
      icon: "square",
      compact: true,
      disabled: !available || !running,
      onClick: () => runServiceAction("stop", stopBtn),
    });

    const hero = el("section", { class: `ecm-hero-card is-${tone}` });
    const top = el(
      "div",
      { class: "ecm-hero-top" },
      el(
        "div",
        { class: "ecm-hero-identity" },
        el("div", { class: "ecm-hero-emblem", "aria-hidden": "true" }, icon("server", 21)),
        el(
          "div",
          { class: "ecm-hero-title-group" },
          el(
            "div",
            { class: "ecm-hero-title-row" },
            el("h2", { class: "ecm-hero-title" }, "Caddy 服务"),
            badge(statusLabel(svc.state), tone, { dot: true, pulse: running && !svc.error }),
            (data && data.caddyVersion)
              ? el("span", { class: "ecm-chip ecm-mono" }, data.caddyVersion)
              : null,
          ),
          el(
            "div",
            { class: "ecm-hero-sub" },
            el("span", { class: "ecm-mono" }, svc.unit || "caddy.service"),
            svc.activeEnterTimestamp
              ? el("span", { title: fmtDateTime(svc.activeEnterTimestamp, { seconds: true }) }, `运行始于 ${fmtRelative(svc.activeEnterTimestamp)}`)
              : null,
            unitDetails ? helpTip(unitDetails, "服务单元") : null,
          ),
        ),
      ),
      el(
        "div",
        { class: "ecm-hero-actions" },
        el("div", { class: "ecm-service-action-group", role: "group", "aria-label": "启动与重载" },
          running ? reloadBtn : startBtn,
          running ? null : reloadBtn,
        ),
        el("div", { class: "ecm-service-action-group", role: "group", "aria-label": "会中断服务的操作" },
          restartBtn,
          stopBtn,
        ),
      ),
    );
    hero.append(top);

    if (svc.error) {
      hero.append(
        el(
          "div",
          { class: "ecm-hero-notice" },
          feedback(
            svc.error.code ? `${svc.error.message || "服务状态不可用"}（${svc.error.code}）` : (svc.error.message || "服务状态不可用"),
            "warning",
            { action: linkButton("前往诊断", "#/diagnostics", { variant: "secondary", compact: true }) },
          ),
        ),
      );
    }

    const metrics = [
      {
        label: "启动时间",
        value: svc.activeEnterTimestamp ? fmtDateTime(svc.activeEnterTimestamp, { seconds: true }) : "—",
        title: svc.activeEnterTimestamp ? fmtRelative(svc.activeEnterTimestamp) : "",
      },
      { label: "主进程 PID", value: svc.mainPid || "—", mono: true },
      { label: "内存占用", value: fmtBytes(svc.memoryBytes) },
      { label: "CPU 时间", value: fmtCpuTime(svc.cpuUsageNs) },
      { label: "开机启动", value: bootStateLabel(svc.bootState) },
    ];
    const strip = el("div", { class: "ecm-hero-metrics" });
    for (const item of metrics) {
      strip.append(
        el(
          "div",
          { class: "ecm-hero-metric" },
          el("span", { class: "ecm-meta-label" }, item.label),
          el("span", { class: `ecm-meta-value${item.mono ? " ecm-mono" : ""}`, title: item.title || undefined }, String(item.value)),
        ),
      );
    }
    hero.append(strip);
    return hero;
  }

  function renderCerts(overview) {
    const certs = (overview && overview.certs) || {};
    const items = Array.isArray(certs.items) ? certs.items : [];
    const expiring = Number(certs.expiring || 0);
    const refreshBtn = button("刷新证书", {
      variant: "secondary",
      icon: "refresh-cw",
      compact: true,
      onClick: async () => {
        buttonBusy(refreshBtn, true, "探测中…");
        try {
          const result = await api.refreshCerts(true);
          toast(`证书探测完成：${result.refreshed || 0} 个成功，${result.errors || 0} 个失败。`, "success");
          await load({ silent: true });
        } catch (error) {
          toast(error.message || "证书探测失败", "danger");
        } finally {
          if (!destroyed) buttonBusy(refreshBtn, false);
        }
      },
    });

    const actions = [refreshBtn];
    if (expiring > 0) actions.unshift(badge(`${expiring} 个即将到期`, "warning"));

    const card = section({
      title: "证书",
      help: "显示启用 HTTPS 的站点实际提供的证书。",
      actions,
      children: [],
      flush: true,
    });
    const body = card.querySelector(".ecm-card-body");
    if (items.length === 0) {
      body.append(
        emptyState({
          title: "暂无 HTTPS 域名",
          icon: "shield",
        }),
      );
      return card;
    }
    body.append(
      dataTable({
        label: "证书列表",
        columns: [
          { key: "domain", label: "域名", mono: true },
          { key: "issuer", label: "签发者", hideBelow: "sm" },
          {
            key: "not_after",
            label: "到期时间",
            hideBelow: "sm",
            render: (row) => (row.not_after ? fmtDateTime(row.not_after, { seconds: false }) : "—"),
          },
          {
            key: "days",
            label: "剩余",
            align: "right",
            render: (row) => {
              const tone = certTone(row.days, row.error);
              const pct = Number.isFinite(Number(row.days)) ? Math.max(4, Math.min(100, Math.round((Number(row.days) / 90) * 100))) : 0;
              return el(
                "div",
                { class: "ecm-cert-cell" },
                badge(fmtDays(row.days), tone, {
                  title: row.error || (row.checked_at ? `探测于 ${fmtDateTime(row.checked_at)}` : ""),
                }),
                pct > 0
                  ? el("span", { class: "ecm-cert-bar", "aria-hidden": "true" },
                    el("span", { class: `ecm-cert-bar-fill is-${tone}`, style: { width: `${pct}%` } }))
                  : null,
              );
            },
          },
          {
            key: "checked_at",
            label: "探测时间",
            hideBelow: "md",
            render: (row) => (row.checked_at ? fmtRelative(row.checked_at) : "未探测"),
          },
        ],
        rows: items,
        getRowAriaLabel: (row) => `证书 ${row.domain}`,
      }),
    );
    return card;
  }

  function renderErrors(overview) {
    const errors = Array.isArray(overview.recentErrors)
      ? overview.recentErrors.slice().reverse()
      : [];
    const card = section({
      title: "最近错误",
      help: "最多显示最近 10 条服务、配置应用和日志读取错误。",
      flush: true,
      children: [],
    });
    const body = card.querySelector(".ecm-card-body");
    if (errors.length === 0) {
      body.append(
        emptyState({
          title: "暂无最近错误",
          icon: "check-circle",
        }),
      );
      return card;
    }
    const list = el("ul", { class: "ecm-error-list" });
    for (const item of errors.slice(0, 10)) {
      const entry = el("li", { class: "ecm-error-item" });
      entry.append(icon("alert-circle", 16));
      const text = el("div", { class: "ecm-error-item-body" });
      text.append(el("div", { class: "ecm-error-item-message ecm-mono" }, item.message || "未知错误"));
      text.append(
        el(
          "div",
          { class: "ecm-error-item-meta" },
          el("span", { title: item.time || "" }, item.time ? `${fmtDateTime(item.time, { seconds: true })} · ${fmtRelative(item.time)}` : "时间未知"),
          el("span", { class: "ecm-chip" }, scopeLabel(item.scope)),
        ),
      );
      entry.append(text);
      list.append(entry);
    }
    body.append(el("div", { class: "ecm-card-pad" }, list));
    return card;
  }

  function kpiCard({ label, value, tone = "neutral", icon: iconName, href }) {
    return el(
      "a",
      { class: `ecm-kpi-card is-${tone}`, href },
      el(
        "div",
        { class: "ecm-kpi-head" },
        el("span", null, label),
        el("span", { class: "ecm-kpi-icon", "aria-hidden": "true" }, icon(iconName, 15)),
      ),
      el("div", { class: "ecm-kpi-value ecm-num" }, String(value ?? 0)),
    );
  }

  function render() {
    if (!data || destroyed) return;
    content.replaceChildren();
    ctx.updateServiceStatus?.(data.service);

    const sites = data.sites || {};
    const kpiStrip = el(
      "div",
      { class: "ecm-kpi-strip", role: "region", "aria-label": "站点规模统计" },
      kpiCard({ label: "站点总数", value: sites.total ?? 0, icon: "globe", href: "#/sites?status=all" }),
      kpiCard({ label: "已启用", value: sites.enabled ?? 0, tone: "success", icon: "check-circle", href: "#/sites?status=enabled" }),
      kpiCard({ label: "已停用", value: sites.disabled ?? 0, tone: "neutral", icon: "square", href: "#/sites?status=disabled" }),
      kpiCard({ label: "自定义片段", value: sites.custom ?? 0, tone: "info", icon: "file-text", href: "#/sites?status=custom" }),
      kpiCard({ label: "孤儿记录", value: sites.orphan ?? 0, tone: (sites.orphan || 0) > 0 ? "warning" : "neutral", icon: "database", href: "#/sites?status=orphan" }),
    );

    const grid = el("div", { class: "ecm-overview-grid" }, renderCerts(data), renderErrors(data));
    content.append(renderService(data.service), kpiStrip, grid, snapshotCard);
  }

  async function load(opts = {}) {
    if (!opts.silent) {
      content.replaceChildren(loadingBlock("正在读取概览…"));
      refreshBtn.disabled = true;
    }
    try {
      const result = await api.overview();
      if (destroyed) return;
      data = result || {};
      render();
      loadSnapshot();
    } catch (error) {
      if (destroyed) return;
      content.replaceChildren(
        errorBlock(error, {
          title: "概览加载失败",
          onRetry: () => load(),
        }),
      );
    } finally {
      if (!destroyed) refreshBtn.disabled = false;
    }
  }

  await load();

  return {
    destroy() {
      destroyed = true;
      clearTimeout(snapshotTimer);
      if (drawerViewer) {
        drawerViewer.destroy();
        drawerViewer = null;
      }
      if (drawer) {
        try {
          drawer.close();
        } catch {
          // Already closed.
        }
        drawer = null;
      }
    },
  };
}
