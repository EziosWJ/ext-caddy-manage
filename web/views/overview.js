import api from "../api.js";
import {
  badge,
  button,
  buttonBusy,
  dataTable,
  emptyState,
  errorBlock,
  feedback,
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
  fmtRelative,
  statusLabel,
  statusTone,
} from "../format.js";

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
  const refreshBtn = button("刷新", { variant: "primary", icon: "refresh-cw", onClick: () => load() });
  const logBtn = button("服务日志", {
    variant: "secondary",
    icon: "terminal",
    onClick: () => openLogDrawer(),
  });

  const header = pageHeader({
    title: "概览",
    subtitle: "Caddy 服务状态、站点规模、证书与最近错误。",
    actions: [refreshBtn, logBtn],
  });
  const content = el("div", { class: "ecm-stack" });
  root.append(el("div", { class: "ecm-page" }, header, content));

  let data = null;
  let destroyed = false;
  let drawer = null;
  let drawerViewer = null;

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
    const card = section({
      title: "服务状态",
      actions: [
        badge(statusLabel(svc.state), statusTone(svc.state), { dot: true }),
        el("span", { class: "ecm-chip ecm-mono" }, svc.unit || "caddy.service"),
      ],
      children: [],
    });

    const body = card.querySelector(".ecm-card-body");

    if (svc.error) {
      body.append(
        feedback(svc.error.message || "服务状态不可用", "warning", {
          action: linkButton("前往诊断", "#/diagnostics", { variant: "secondary", compact: true }),
        }),
      );
    }

    body.append(
      metaGrid([
        { label: "Caddy 版本", value: (data && data.caddyVersion) || "未检测", mono: true },
        {
          label: "启动时间",
          value: svc.activeEnterTimestamp ? fmtDateTime(svc.activeEnterTimestamp, { seconds: true }) : "—",
          title: svc.activeEnterTimestamp ? fmtRelative(svc.activeEnterTimestamp) : "",
        },
        { label: "主进程 PID", value: svc.mainPid || "—", mono: true },
        { label: "内存占用", value: fmtBytes(svc.memoryBytes) },
        { label: "CPU 时间", value: fmtCpuTime(svc.cpuUsageNs) },
        { label: "开机启动", value: bootStateLabel(svc.bootState) },
        { label: "服务单元", value: svc.unit || "—", mono: true },
        { label: "单元文件", value: svc.fragmentPath || "—", mono: true, title: svc.fragmentPath || "" },
      ]),
    );

    if (svc.stateDetail) {
      body.append(el("p", { class: "ecm-service-detail" }, svc.stateDetail));
    }
    if (svc.error && svc.error.code) {
      body.append(el("p", { class: "ecm-hint" }, `错误码：${svc.error.code}`));
    }

    const startBtn = button("启动", {
      variant: "secondary",
      icon: "play",
      disabled: !available || running,
      onClick: () => runServiceAction("start", startBtn),
    });
    const stopBtn = button("停止", {
      variant: "secondary",
      icon: "square",
      disabled: !available || !running,
      onClick: () => runServiceAction("stop", stopBtn),
    });
    const restartBtn = button("重启", {
      variant: "secondary",
      icon: "rotate-cw",
      disabled: !available,
      onClick: () => runServiceAction("restart", restartBtn),
    });
    const reloadBtn = button("重载", {
      variant: "secondary",
      icon: "zap",
      disabled: !available || !running,
      title: "校验主配置并让 Caddy 重载",
      onClick: () => runServiceAction("reload", reloadBtn),
    });
    body.append(el("div", { class: "ecm-toolbar ecm-service-actions" }, startBtn, stopBtn, restartBtn, reloadBtn));
    return card;
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
      description: "只显示启用 HTTPS 的站点域名；探测结果反映实际服务中的证书。",
      actions,
      children: [],
      flush: true,
    });
    const body = card.querySelector(".ecm-card-body");
    if (items.length === 0) {
      body.append(
        emptyState({
          title: "暂无 HTTPS 域名",
          body: "为站点启用 HTTPS 后，这里会显示证书签发者与到期时间。",
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
            render: (row) =>
              badge(fmtDays(row.days), certTone(row.days, row.error), {
                title: row.error || (row.checked_at ? `探测于 ${fmtDateTime(row.checked_at)}` : ""),
              }),
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
      description: "保留最近 10 条服务、配置应用与日志读取错误，最新在前。",
      children: [],
    });
    const body = card.querySelector(".ecm-card-body");
    if (errors.length === 0) {
      body.append(
        emptyState({
          title: "暂无最近错误",
          body: "一旦出现配置校验、重载或服务操作错误，会在这里记录。",
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
    body.append(list);
    return card;
  }

  function render() {
    if (!data || destroyed) return;
    content.replaceChildren();


    content.append(renderService(data.service));

    const sites = data.sites || {};
    const tiles = el("div", { class: "ecm-tiles" });
    tiles.append(
      statTile({ label: "站点总数", value: sites.total ?? 0, icon: "globe" }),
      statTile({ label: "已启用", value: sites.enabled ?? 0, tone: "success", icon: "check-circle" }),
      statTile({ label: "已停用", value: sites.disabled ?? 0, icon: "square" }),
      statTile({ label: "自定义片段", value: sites.custom ?? 0, tone: "info", icon: "file-text" }),
      statTile({ label: "孤儿记录", value: sites.orphan ?? 0, tone: (sites.orphan || 0) > 0 ? "warning" : "neutral", icon: "database" }),
    );
    content.append(section({ title: "站点规模", children: tiles }));

    const grid = el("div", { class: "ecm-overview-grid" });
    grid.append(renderCerts(data), renderErrors(data));
    content.append(grid);
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
