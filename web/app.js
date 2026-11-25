// Application shell and hash router.

import api from "./api.js";
import { el, icon, errorBlock, banner, linkButton } from "./components.js";
import * as overviewView from "./views/overview.js";
import * as sitesView from "./views/sites.js";
import * as wizardView from "./views/wizard.js";
import * as siteView from "./views/site.js";
import * as globalView from "./views/global.js";
import * as diagnosticsView from "./views/diagnostics.js";

const NAV_ITEMS = [
  { id: "overview", label: "概览", icon: "dashboard", hash: "#/overview" },
  { id: "sites", label: "站点", icon: "globe", hash: "#/sites" },
  { id: "global", label: "全局配置", icon: "settings", hash: "#/global" },
  { id: "diagnostics", label: "诊断", icon: "activity", hash: "#/diagnostics" },
];

const VIEWS = {
  overview: overviewView,
  sites: sitesView,
  newSite: wizardView,
  site: siteView,
  global: globalView,
  diagnostics: diagnosticsView,
};

const TITLES = {
  overview: "概览",
  sites: "站点",
  newSite: "新建站点",
  site: "站点详情",
  global: "全局配置",
  diagnostics: "诊断",
};

function parseRoute(hashValue) {
  let path = String(hashValue || "").replace(/^#/, "");
  if (path === "") path = "/overview";
  if (!path.startsWith("/")) path = `/${path}`;
  if (path === "/" || path === "/overview") {
    return { name: "overview", view: "overview", nav: "overview", canonical: "#/overview" };
  }
  if (path === "/sites") {
    return { name: "sites", view: "sites", nav: "sites", canonical: "#/sites" };
  }
  if (path === "/sites/new") {
    return { name: "newSite", view: "newSite", nav: "sites", canonical: "#/sites/new" };
  }
  const detail = path.match(/^\/sites\/([^/]+)$/);
  if (detail) {
    let slug = detail[1];
    try {
      slug = decodeURIComponent(slug);
    } catch {
      slug = "";
    }
    if (/^[A-Za-z0-9._-]{1,128}$/.test(slug) && !slug.includes("..")) {
      return {
        name: "site",
        view: "site",
        nav: "sites",
        canonical: `#/sites/${encodeURIComponent(slug)}`,
        slug,
      };
    }
  }
  if (path === "/global") {
    return { name: "global", view: "global", nav: "global", canonical: "#/global" };
  }
  if (path === "/diagnostics") {
    return { name: "diagnostics", view: "diagnostics", nav: "diagnostics", canonical: "#/diagnostics" };
  }
  return { name: "overview", view: "overview", nav: "overview", canonical: "#/overview", unknown: true };
}

function titleFor(route) {
  return `${TITLES[route.name] || "Caddy 管理"} · Caddy 管理`;
}

function buildShell() {
  const app = document.getElementById("app");
  if (!app) return null;

  const skip = el(
    "a",
    {
      class: "ecm-skip",
      href: "#ecm-main",
      onClick: (event) => {
        event.preventDefault();
        const main = document.getElementById("ecm-main");
        if (main) main.focus();
      },
    },
    "跳到主要内容",
  );

  const brand = el(
    "a",
    { class: "ecm-brand", href: "#/overview", "aria-label": "Caddy 管理首页" },
    el("span", { class: "ecm-brand-mark", "aria-hidden": "true" }, icon("shield-check", 20)),
    el("span", { class: "ecm-brand-text" }, "Caddy 管理"),
  );

  const nav = el("nav", { class: "ecm-nav", "aria-label": "主导航" });
  for (const item of NAV_ITEMS) {
    nav.append(
      el(
        "a",
        {
          class: "ecm-nav-link",
          href: item.hash,
          "data-route": item.id,
          "aria-label": item.label,
        },
        icon(item.icon, 18),
        el("span", { class: "ecm-nav-label" }, item.label),
      ),
    );
  }

  const header = el("header", { class: "ecm-header" }, brand, nav);
  const bannerHost = el("div", {
    class: "ecm-global-banner ecm-container",
    id: "ecm-global-banner",
    hidden: true,
  });
  const viewRoot = el("div", { class: "ecm-view-root ecm-container", id: "ecm-view-root" });
  const main = el("main", { class: "ecm-main", id: "ecm-main", tabindex: "-1" }, bannerHost, viewRoot);
  const shell = el("div", { class: "ecm-shell" }, header, main);
  app.replaceChildren(skip, shell);
  return { app, viewRoot, bannerHost };
}

const shell = buildShell();
const routeRoot = shell ? shell.viewRoot : null;
const bannerHost = shell ? shell.bannerHost : null;

function renderHealthBanner(health) {
  if (!bannerHost) return;
  const initialized = health && health.initialized !== false;
  const hasMarkers = health && health.hasMarkers !== false;
  const hasImport = health && health.hasImport !== false;
  if (initialized && hasMarkers && hasImport) {
    bannerHost.replaceChildren();
    bannerHost.hidden = true;
    return;
  }
  const messages = [];
  if (!initialized) messages.push("主 Caddyfile 不存在或尚未生成。");
  if (!hasMarkers) messages.push("缺少受管全局块标记，全局配置表单不可用。");
  if (!hasImport) messages.push("主 Caddyfile 未导入站点片段目录，站点写入不会生效。");
  const node = banner({
    tone: "warning",
    title: "Caddy 配置尚未就绪",
    message: messages.join(" "),
    actions: linkButton("前往诊断", "#/diagnostics", { variant: "secondary", compact: true }),
  });
  bannerHost.replaceChildren(node);
  bannerHost.hidden = false;
}

let healthCheckSeq = 0;
async function checkHealthBanner() {
  const seq = (healthCheckSeq += 1);
  try {
    const health = await api.health();
    if (seq === healthCheckSeq) renderHealthBanner(health);
  } catch {
    // The plugin page itself would not render if the instance were stopped; a
    // transient health failure must not replace the current view.
  }
}

let activeHash = "#/overview";
let activeView = null;
let renderSeq = 0;
let navigatedDuringGuard = false;

function updateNav(navId) {
  if (!document.querySelector) return;
  for (const link of document.querySelectorAll(".ecm-nav-link")) {
    if (link.dataset.route === navId) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

function navigate(hash) {
  const target = hash.startsWith("#") ? hash : `#${hash}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
}

function closeOpenDialogs() {
  for (const dialog of document.querySelectorAll("dialog[open]")) {
    try {
      dialog.close();
    } catch {
      // Ignore dialogs already closing.
    }
  }
}

async function renderRoute(route) {
  if (!routeRoot) return;
  const seq = (renderSeq += 1);
  closeOpenDialogs();

  if (activeView && typeof activeView.destroy === "function") {
    try {
      activeView.destroy();
    } catch {
      // A view teardown must never block navigation.
    }
  }
  activeView = null;

  activeHash = route.canonical;
  if (window.location.hash !== route.canonical) {
    try {
      window.history.replaceState(null, "", route.canonical);
    } catch {
      window.location.hash = route.canonical;
    }
  }
  updateNav(route.nav);
  document.title = titleFor(route);
  checkHealthBanner();

  const controller = new AbortController();
  const container = el("div", { class: "ecm-view", id: "ecm-view", tabindex: "-1" });
  routeRoot.replaceChildren(container);

  const view = VIEWS[route.view];
  const ctx = {
    navigate,
    signal: controller.signal,
    refreshHealth: () => checkHealthBanner(),
    setTitle: (text) => {
      if (seq === renderSeq) {
        document.title = text ? `${text} · Caddy 管理` : titleFor(route);
      }
    },
  };

  let result = null;
  try {
    if (!view || typeof view.mount !== "function") {
      throw new Error("未知视图");
    }
    result = await view.mount(container, ctx, route);
  } catch (error) {
    if (seq !== renderSeq) return;
    container.replaceChildren(
      errorBlock(error, {
        title: "页面加载失败",
        onRetry: () => {
          const current = parseRoute(window.location.hash);
          renderRoute(current);
        },
      }),
    );
    return;
  }

  if (seq !== renderSeq) {
    if (result && typeof result.destroy === "function") {
      try {
        result.destroy();
      } catch {
        // Ignore stale view teardown failures.
      }
    }
    controller.abort();
    return;
  }

  activeView = result || {};
  const heading = container.querySelector("h1");
  const focusTarget = heading || container;
  if (focusTarget && typeof focusTarget.focus === "function") {
    focusTarget.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

async function handleNavigation() {
  let target = parseRoute(window.location.hash);

  if (target.unknown) {
    try {
      window.history.replaceState(null, "", target.canonical);
    } catch {
      window.location.hash = target.canonical;
    }
  }

  if (target.canonical === activeHash && activeView) return;

  if (navigatedDuringGuard) return;
  navigatedDuringGuard = true;
  try {
    if (activeView && typeof activeView.beforeLeave === "function") {
      let allowed = true;
      try {
        allowed = await activeView.beforeLeave();
      } catch {
        allowed = true;
      }
      if (!allowed) {
        try {
          window.history.replaceState(null, "", activeHash);
        } catch {
          window.location.hash = activeHash;
        }
        return;
      }
    }

    target = parseRoute(window.location.hash);
    if (target.canonical === activeHash) return;
    await renderRoute(target);
  } finally {
    navigatedDuringGuard = false;
    const latest = parseRoute(window.location.hash);
    if (latest.canonical !== activeHash) {
      // A hash change happened while a guard or render was in progress.
      setTimeout(() => {
        handleNavigation();
      }, 0);
    }
  }
}

window.addEventListener("hashchange", () => {
  handleNavigation();
});

window.addEventListener("unhandledrejection", (event) => {
  // AbortErrors are expected during navigation; everything else is surfaced.
  if (event.reason && event.reason.name === "AbortError") {
    event.preventDefault();
  }
});

if (routeRoot) {
  const initial = parseRoute(window.location.hash);
  if (initial.unknown) {
    try {
      window.history.replaceState(null, "", initial.canonical);
    } catch {
      // Ignore.
    }
  }
  renderRoute(initial).catch((error) => {
    routeRoot.replaceChildren(errorBlock(error, { title: "应用初始化失败" }));
  });
}
