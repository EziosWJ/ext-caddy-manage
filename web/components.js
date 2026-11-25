// Shared DOM builders and UI primitives. Everything user-visible is created with
// textContent / createTextNode; server data is never injected as HTML.

import api from "./api.js";
import {
  byteLength,
  diffLines,
  diffStats,
  fmtBytes,
  fmtDateTime,
  fmtDurationMs,
  fmtLogTime,
  httpStatusTone,
  statusTone,
} from "./format.js";

let uidCounter = 0;
export function uid(prefix = "ecm") {
  uidCounter += 1;
  return `${prefix}-${uidCounter}`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide-style stroke icons, stored as trusted static primitives.
const ICONS = {
  dashboard: [
    ["rect", { x: "3", y: "3", width: "7", height: "9", rx: "1" }],
    ["rect", { x: "14", y: "3", width: "7", height: "5", rx: "1" }],
    ["rect", { x: "14", y: "12", width: "7", height: "9", rx: "1" }],
    ["rect", { x: "3", y: "16", width: "7", height: "5", rx: "1" }],
  ],
  globe: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["line", { x1: "2", y1: "12", x2: "22", y2: "12" }],
    [
      "path",
      {
        d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z",
      },
    ],
  ],
  settings: [
    [
      "path",
      {
        d: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
      },
    ],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  activity: [["path", { d: "M22 12h-4l-3 9L9 3l-3 9H2" }]],
  "refresh-cw": [
    ["path", { d: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
    ["path", { d: "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" }],
    ["path", { d: "M8 16H3v5" }],
  ],
  play: [["polygon", { points: "6 3 20 12 6 21 6 3" }]],
  square: [["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }]],
  "rotate-cw": [
    ["path", { d: "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" }],
    ["path", { d: "M21 3v5h-5" }],
  ],
  "rotate-ccw": [
    ["path", { d: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" }],
    ["path", { d: "M3 3v5h5" }],
  ],
  zap: [["polygon", { points: "13 2 3 14 12 14 11 22 21 10 12 10 13 2" }]],
  terminal: [
    ["polyline", { points: "4 17 10 11 4 5" }],
    ["line", { x1: "12", y1: "19", x2: "20", y2: "19" }],
  ],
  plus: [
    ["line", { x1: "12", y1: "5", x2: "12", y2: "19" }],
    ["line", { x1: "5", y1: "12", x2: "19", y2: "12" }],
  ],
  trash: [
    ["polyline", { points: "3 6 5 6 21 6" }],
    ["path", { d: "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" }],
    ["path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }],
    ["line", { x1: "10", y1: "11", x2: "10", y2: "17" }],
    ["line", { x1: "14", y1: "11", x2: "14", y2: "17" }],
  ],
  x: [
    ["line", { x1: "18", y1: "6", x2: "6", y2: "18" }],
    ["line", { x1: "6", y1: "6", x2: "18", y2: "18" }],
  ],
  check: [["polyline", { points: "20 6 9 17 4 12" }]],
  "check-circle": [
    ["path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }],
    ["polyline", { points: "22 4 12 14.01 9 11.01" }],
  ],
  "x-circle": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["line", { x1: "15", y1: "9", x2: "9", y2: "15" }],
    ["line", { x1: "9", y1: "9", x2: "15", y2: "15" }],
  ],
  "alert-triangle": [
    [
      "path",
      {
        d: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z",
      },
    ],
    ["line", { x1: "12", y1: "9", x2: "12", y2: "13" }],
    ["line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }],
  ],
  "alert-circle": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["line", { x1: "12", y1: "8", x2: "12", y2: "12" }],
    ["line", { x1: "12", y1: "16", x2: "12.01", y2: "16" }],
  ],
  info: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["line", { x1: "12", y1: "16", x2: "12", y2: "12" }],
    ["line", { x1: "12", y1: "8", x2: "12.01", y2: "8" }],
  ],
  "help-circle": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" }],
    ["line", { x1: "12", y1: "17", x2: "12.01", y2: "17" }],
  ],
  "chevron-down": [["polyline", { points: "6 9 12 15 18 9" }]],
  "chevron-up": [["polyline", { points: "18 15 12 9 6 15" }]],
  "chevron-left": [["polyline", { points: "15 18 9 12 15 6" }]],
  "chevron-right": [["polyline", { points: "9 18 15 12 9 6" }]],
  "arrow-left": [
    ["line", { x1: "19", y1: "12", x2: "5", y2: "12" }],
    ["polyline", { points: "12 19 5 12 12 5" }],
  ],
  "arrow-right": [
    ["line", { x1: "5", y1: "12", x2: "19", y2: "12" }],
    ["polyline", { points: "12 5 19 12 12 19" }],
  ],
  search: [
    ["circle", { cx: "11", cy: "11", r: "8" }],
    ["line", { x1: "21", y1: "21", x2: "16.65", y2: "16.65" }],
  ],
  filter: [["polygon", { points: "22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" }]],
  "external-link": [
    ["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
    ["polyline", { points: "15 3 21 3 21 9" }],
    ["line", { x1: "10", y1: "14", x2: "21", y2: "3" }],
  ],
  download: [
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
    ["polyline", { points: "7 10 12 15 17 10" }],
    ["line", { x1: "12", y1: "15", x2: "12", y2: "3" }],
  ],
  upload: [
    ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
    ["polyline", { points: "17 8 12 3 7 8" }],
    ["line", { x1: "12", y1: "3", x2: "12", y2: "15" }],
  ],
  "file-text": [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["line", { x1: "16", y1: "13", x2: "8", y2: "13" }],
    ["line", { x1: "16", y1: "17", x2: "8", y2: "17" }],
    ["line", { x1: "10", y1: "9", x2: "8", y2: "9" }],
  ],
  "file-plus": [
    ["path", { d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" }],
    ["polyline", { points: "14 2 14 8 20 8" }],
    ["line", { x1: "12", y1: "18", x2: "12", y2: "12" }],
    ["line", { x1: "9", y1: "15", x2: "15", y2: "15" }],
  ],
  folder: [
    ["path", { d: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" }],
  ],
  shield: [["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }]],
  "shield-check": [
    ["path", { d: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" }],
    ["polyline", { points: "9 12 11 14 15 10" }],
  ],
  lock: [
    ["rect", { x: "3", y: "11", width: "18", height: "11", rx: "2" }],
    ["path", { d: "M7 11V7a5 5 0 0 1 10 0v4" }],
  ],
  key: [
    ["circle", { cx: "7.5", cy: "15.5", r: "5.5" }],
    ["path", { d: "M21 2l-9.6 9.6" }],
    ["path", { d: "M15.5 7.5l3 3L22 7l-3-3" }],
  ],
  server: [
    ["rect", { x: "2", y: "2", width: "20", height: "8", rx: "2" }],
    ["rect", { x: "2", y: "14", width: "20", height: "8", rx: "2" }],
    ["line", { x1: "6", y1: "6", x2: "6.01", y2: "6" }],
    ["line", { x1: "6", y1: "18", x2: "6.01", y2: "18" }],
  ],
  database: [
    ["ellipse", { cx: "12", cy: "5", rx: "9", ry: "3" }],
    ["path", { d: "M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" }],
    ["path", { d: "M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" }],
  ],
  clock: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["polyline", { points: "12 6 12 12 16 14" }],
  ],
  copy: [
    ["rect", { x: "9", y: "9", width: "13", height: "13", rx: "2" }],
    ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }],
  ],
  eye: [
    ["path", { d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  edit: [
    ["path", { d: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" }],
    ["path", { d: "M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" }],
  ],
  save: [
    ["path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" }],
    ["polyline", { points: "17 21 17 13 7 13 7 21" }],
    ["polyline", { points: "7 3 7 8 15 8" }],
  ],
  pause: [
    ["rect", { x: "6", y: "4", width: "4", height: "16" }],
    ["rect", { x: "14", y: "4", width: "4", height: "16" }],
  ],
  loader: [["path", { d: "M21 12a9 9 0 1 1-6.219-8.56" }]],
  "more-horizontal": [
    ["circle", { cx: "5", cy: "12", r: "1" }],
    ["circle", { cx: "12", cy: "12", r: "1" }],
    ["circle", { cx: "19", cy: "12", r: "1" }],
  ],
  menu: [
    ["line", { x1: "3", y1: "6", x2: "21", y2: "6" }],
    ["line", { x1: "3", y1: "12", x2: "21", y2: "12" }],
    ["line", { x1: "3", y1: "18", x2: "21", y2: "18" }],
  ],
  "git-compare": [
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["circle", { cx: "18", cy: "18", r: "3" }],
    ["path", { d: "M6 9v3a3 3 0 0 0 3 3h6" }],
    ["path", { d: "M18 15V9a3 3 0 0 0-3-3H9" }],
  ],
  sparkles: [
    [
      "path",
      {
        d: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z",
      },
    ],
    ["path", { d: "M5 3v2" }],
    ["path", { d: "M19 19v2" }],
  ],
  power: [
    ["path", { d: "M18.36 6.64a9 9 0 1 1-12.73 0" }],
    ["line", { x1: "12", y1: "2", x2: "12", y2: "12" }],
  ],
  link: [
    [
      "path",
      { d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" },
    ],
    [
      "path",
      { d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" },
    ],
  ],
  list: [
    ["line", { x1: "8", y1: "6", x2: "21", y2: "6" }],
    ["line", { x1: "8", y1: "12", x2: "21", y2: "12" }],
    ["line", { x1: "8", y1: "18", x2: "21", y2: "18" }],
    ["line", { x1: "3", y1: "6", x2: "3.01", y2: "6" }],
    ["line", { x1: "3", y1: "12", x2: "3.01", y2: "12" }],
    ["line", { x1: "3", y1: "18", x2: "3.01", y2: "18" }],
  ],
  calendar: [
    ["rect", { x: "3", y: "4", width: "18", height: "18", rx: "2" }],
    ["line", { x1: "16", y1: "2", x2: "16", y2: "6" }],
    ["line", { x1: "8", y1: "2", x2: "8", y2: "6" }],
    ["line", { x1: "3", y1: "10", x2: "21", y2: "10" }],
  ],
  hash: [
    ["line", { x1: "4", y1: "9", x2: "20", y2: "9" }],
    ["line", { x1: "4", y1: "15", x2: "20", y2: "15" }],
    ["line", { x1: "10", y1: "3", x2: "8", y2: "21" }],
    ["line", { x1: "16", y1: "3", x2: "14", y2: "21" }],
  ],
  minus: [["line", { x1: "5", y1: "12", x2: "19", y2: "12" }]],
  inbox: [
    ["polyline", { points: "22 12 16 12 14 15 10 15 8 12 2 12" }],
    [
      "path",
      {
        d: "M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
      },
    ],
  ],
  circle: [["circle", { cx: "12", cy: "12", r: "10" }]],
};

export function icon(name, size = 16, opts = {}) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(opts.strokeWidth || 2));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", `ecm-icon${opts.className ? ` ${opts.className}` : ""}`);
  const spec = ICONS[name] || ICONS.circle;
  for (const [tag, attrs] of spec) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    svg.append(node);
  }
  return svg;
}

function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
      continue;
    }
    if (child instanceof Node) {
      node.append(child);
      continue;
    }
    node.append(document.createTextNode(String(child)));
  }
}

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === "class" || key === "className") {
        node.setAttribute("class", String(value));
        continue;
      }
      if (key === "dataset" && typeof value === "object") {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          if (dataValue === undefined || dataValue === null) continue;
          node.dataset[dataKey] = String(dataValue);
        }
        continue;
      }
      if (key === "style" && typeof value === "object") {
        Object.assign(node.style, value);
        continue;
      }
      if (key === "text") {
        node.textContent = String(value);
        continue;
      }
      if (key === "html") {
        // Deliberately ignored: server data must never be interpreted as markup.
        continue;
      }
      if (key.startsWith("on") && key.length > 2 && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }
      const booleanProps = new Set([
        "checked",
        "disabled",
        "selected",
        "hidden",
        "required",
        "multiple",
        "readOnly",
        "open",
      ]);
      if (booleanProps.has(key)) {
        node[key] = Boolean(value);
        continue;
      }
      if (key === "value") {
        node.value = value;
        continue;
      }
      if (key.startsWith("aria-") || key === "role") {
        node.setAttribute(key, value === true ? "true" : value === false ? "false" : String(value));
        continue;
      }
      if (value === false) continue;
      if (value === true) {
        node.setAttribute(key, "");
        continue;
      }
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function spinner(size = 16) {
  const wrap = el("span", { class: "ecm-spinner", "aria-hidden": "true" });
  wrap.append(icon("loader", size));
  return wrap;
}

export function button(label, opts = {}) {
  const {
    variant = "secondary",
    icon: iconName,
    iconSize,
    onClick,
    disabled = false,
    type = "button",
    title,
    ariaLabel,
    compact = false,
    block = false,
    loading = false,
    className,
    id,
  } = opts;
  const classes = ["ecm-btn", `ecm-btn-${variant}`];
  if (compact) classes.push("ecm-btn-compact");
  if (block) classes.push("ecm-btn-block");
  if (!label && iconName) classes.push("ecm-btn-icon-only");
  if (className) classes.push(className);
  const btn = el(
    "button",
    {
      class: classes.join(" "),
      type,
      id,
      disabled: disabled || loading,
      title: title || undefined,
      "aria-label": ariaLabel || (label ? undefined : iconName || "操作"),
      "aria-busy": loading ? "true" : undefined,
    },
    loading ? spinner(14) : iconName ? icon(iconName, iconSize || (compact ? 16 : 20)) : null,
    label ? el("span", { class: "ecm-btn-label" }, label) : null,
  );
  if (onClick) btn.addEventListener("click", onClick);
  return btn;
}

export function linkButton(label, href, opts = {}) {
  const { variant = "secondary", icon: iconName, compact = false, className, title } = opts;
  const classes = ["ecm-btn", `ecm-btn-${variant}`];
  if (compact) classes.push("ecm-btn-compact");
  if (className) classes.push(className);
  return el(
    "a",
    { class: classes.join(" "), href, title },
    iconName ? icon(iconName, compact ? 16 : 20) : null,
    el("span", { class: "ecm-btn-label" }, label),
  );
}

/** Swap a button into a busy state without losing its original content. */
export function buttonBusy(btn, busy, busyLabel = "处理中…") {
  if (!btn) return;
  if (busy) {
    if (!btn._ecmIdleChildren) {
      btn._ecmIdleChildren = Array.from(btn.childNodes).map((node) => node.cloneNode(true));
      btn._ecmIdleDisabled = btn.disabled;
    }
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.replaceChildren(spinner(14), el("span", { class: "ecm-btn-label" }, busyLabel));
  } else {
    btn.removeAttribute("aria-busy");
    if (btn._ecmIdleChildren) btn.replaceChildren(...btn._ecmIdleChildren);
    btn.disabled = Boolean(btn._ecmIdleDisabled);
    delete btn._ecmIdleChildren;
    delete btn._ecmIdleDisabled;
  }
}

export function badge(text, tone = "neutral", opts = {}) {
  const node = el(
    "span",
    { class: `ecm-badge ecm-badge-${tone}`, title: opts.title },
    opts.dot ? el("span", { class: `ecm-dot ecm-dot-${tone}`, "aria-hidden": "true" }) : null,
    el("span", { class: "ecm-badge-text" }, text),
  );
  return node;
}

function toneIcon(tone) {
  switch (tone) {
    case "success":
      return "check-circle";
    case "warning":
      return "alert-triangle";
    case "danger":
      return "alert-circle";
    case "info":
      return "info";
    default:
      return "info";
  }
}

let activeHelp;

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !activeHelp?.isConnected) return;
  event.preventDefault();
  event.stopPropagation();
  activeHelp.hidden = true;
  activeHelp = null;
}, true);

export function helpTip(message, label) {
  const tip = el("span", { class: "ecm-help-tip", id: uid("help"), role: "tooltip", hidden: true }, message);
  const trigger = el(
    "button",
    {
      class: "ecm-help-trigger",
      type: "button",
      "aria-label": label ? `${label}说明` : "说明",
      "aria-describedby": tip.id,
    },
    icon("help-circle", 16),
  );
  const root = el("span", { class: "ecm-help" }, trigger, tip);
  function show() {
    if (activeHelp && activeHelp !== tip) activeHelp.hidden = true;
    activeHelp = tip;
    tip.hidden = false;
    tip.style.removeProperty("--ecm-tip-shift");
    root.classList.remove("ecm-help-above");
    const bounds = tip.getBoundingClientRect();
    const viewport = document.documentElement;
    const shift = Math.max(8 - bounds.left, 0) - Math.max(bounds.right - viewport.clientWidth + 8, 0);
    tip.style.setProperty("--ecm-tip-shift", `${shift}px`);
    const dialogBody = root.closest(".ecm-dialog-body")?.getBoundingClientRect();
    const top = Math.max(0, dialogBody?.top ?? 0);
    const bottom = Math.min(viewport.clientHeight, dialogBody?.bottom ?? viewport.clientHeight);
    if (bounds.bottom > bottom && root.getBoundingClientRect().top - bounds.height >= top) {
      root.classList.add("ecm-help-above");
    }
  }
  function hide() {
    tip.hidden = true;
    if (activeHelp === tip) activeHelp = null;
  }
  root.addEventListener("pointerenter", show);
  root.addEventListener("pointerleave", () => {
    if (document.activeElement !== trigger) hide();
  });
  trigger.addEventListener("focus", show);
  trigger.addEventListener("click", show);
  trigger.addEventListener("blur", () => {
    if (!root.matches(":hover")) hide();
  });
  return root;
}

function makeField(control, opts = {}) {
  const { label, hint, error, required = false, id, className } = opts;
  const controlId = id || control.id || uid("field");
  control.id = controlId;
  const root = el("div", { class: `ecm-field${className ? ` ${className}` : ""}` });
  const heading = el("div", { class: "ecm-field-heading", hidden: true });
  if (label) heading.append(
    el(
      "label",
      { class: "ecm-label", for: controlId },
      label,
      required ? el("span", { class: "ecm-req", "aria-hidden": "true" }, " *") : null,
    ),
  );
  root.append(heading, control);
  const described = [];
  let help = null;
  let errorEl = null;
  const syncDescribed = () => {
    if (described.length > 0) control.setAttribute("aria-describedby", described.join(" "));
    else control.removeAttribute("aria-describedby");
  };
  const fieldApi = {
    root,
    control,
    setError(message) {
      if (message) {
        if (!errorEl) {
          errorEl = el("p", { class: "ecm-field-error", id: uid("err"), role: "alert" });
          root.append(errorEl);
          described.push(errorEl.id);
        }
        errorEl.textContent = String(message);
        control.setAttribute("aria-invalid", "true");
        root.classList.add("ecm-field-invalid");
      } else if (errorEl) {
        const index = described.indexOf(errorEl.id);
        if (index >= 0) described.splice(index, 1);
        errorEl.remove();
        errorEl = null;
        control.removeAttribute("aria-invalid");
        root.classList.remove("ecm-field-invalid");
      }
      syncDescribed();
    },
    setHint(message) {
      if (help) {
        described.splice(described.indexOf(help.lastElementChild.id), 1);
        help.remove();
        help = null;
      }
      if (message) {
        help = helpTip(message, label);
        heading.append(help);
        described.push(help.lastElementChild.id);
      }
      heading.hidden = !label && !help;
      syncDescribed();
    },
  };
  fieldApi.setHint(hint);
  if (error) fieldApi.setError(error);
  return fieldApi;
}

export function field(opts) {
  return makeField(opts.control, opts).root;
}

export function inputField(opts = {}) {
  const {
    value = "",
    type = "text",
    placeholder,
    hint,
    error,
    required,
    maxLength,
    min,
    max,
    step,
    pattern,
    inputMode,
    autocomplete = "off",
    onInput,
    onChange,
    disabled,
    readOnly,
    mono,
    label,
    name,
    className,
    id,
    spellcheck = false,
  } = opts;
  const input = el("input", {
    class: `ecm-control${mono ? " ecm-mono" : ""}${className ? ` ${className}` : ""}`,
    type,
    value,
    placeholder,
    required,
    maxlength: maxLength,
    min,
    max,
    step,
    pattern,
    inputmode: inputMode,
    autocomplete,
    disabled,
    readonly: readOnly,
    spellcheck,
    name,
  });
  if (onInput) input.addEventListener("input", () => onInput(input.value, input));
  if (onChange) input.addEventListener("change", () => onChange(input.value, input));
  return makeField(input, { label, hint, error, required, id });
}

export function textareaField(opts = {}) {
  const {
    value = "",
    rows = 4,
    placeholder,
    hint,
    error,
    required,
    maxLength,
    onInput,
    disabled,
    mono,
    label,
    name,
    className,
    id,
    resize,
  } = opts;
  const textarea = el("textarea", {
    class: `ecm-control ecm-textarea${mono ? " ecm-mono" : ""}${className ? ` ${className}` : ""}`,
    rows,
    placeholder,
    required,
    maxlength: maxLength,
    disabled,
    name,
    spellcheck: false,
  });
  textarea.value = value;
  if (resize) textarea.style.resize = resize;
  if (onInput) textarea.addEventListener("input", () => onInput(textarea.value, textarea));
  return makeField(textarea, { label, hint, error, required, id });
}

export function selectField(opts = {}) {
  const {
    label,
    options = [],
    value,
    hint,
    error,
    required,
    onChange,
    disabled,
    className,
    id,
  } = opts;
  const select = el("select", {
    class: `ecm-control ecm-select${className ? ` ${className}` : ""}`,
    required,
    disabled,
  });
  for (const option of options) {
    const optionValue = typeof option === "string" ? option : option.value;
    const optionLabel = typeof option === "string" ? option : option.label;
    select.append(el("option", { value: optionValue }, optionLabel));
  }
  if (value !== undefined && value !== null) select.value = String(value);
  if (onChange) select.addEventListener("change", () => onChange(select.value, select));
  return makeField(select, { label, hint, error, required, id });
}

export function checkboxField(opts = {}) {
  const {
    label,
    hint,
    error,
    checked = false,
    onChange,
    disabled = false,
    id,
  } = opts;
  const input = el("input", {
    class: "ecm-check-input",
    type: "checkbox",
    id: id || uid("check"),
    checked: Boolean(checked),
    disabled,
  });
  if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
  const box = el("span", { class: "ecm-check-box", "aria-hidden": "true" }, icon("check", 12));
  const root = el("div", { class: "ecm-field ecm-field-choice" });
  root.append(
    el(
      "label",
      { class: "ecm-check", for: input.id },
      input,
      box,
      el("span", { class: "ecm-check-label" }, label || ""),
    ),
  );
  addChoiceHelp(root, input, hint, label);
  let errorEl = null;
  const fieldApi = {
    root,
    control: input,
    setError(message) {
      if (message) {
        if (!errorEl) {
          errorEl = el("p", { class: "ecm-field-error ecm-hint-indent", role: "alert" });
          root.append(errorEl);
        }
        errorEl.textContent = String(message);
        root.classList.add("ecm-field-invalid");
      } else if (errorEl) {
        errorEl.remove();
        errorEl = null;
        root.classList.remove("ecm-field-invalid");
      }
    },
    setHint() {},
  };
  if (error) fieldApi.setError(error);
  return fieldApi;
}

export function switchField(opts = {}) {
  const {
    label,
    hint,
    error,
    checked = false,
    onChange,
    disabled = false,
    id,
  } = opts;
  const input = el("input", {
    class: "ecm-switch-input",
    type: "checkbox",
    id: id || uid("switch"),
    checked: Boolean(checked),
    disabled,
    role: "switch",
  });
  if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
  const root = el("div", { class: "ecm-field ecm-field-choice" });
  root.append(
    el(
      "label",
      { class: "ecm-switch", for: input.id },
      input,
      el("span", { class: "ecm-switch-track", "aria-hidden": "true" }),
      el("span", { class: "ecm-switch-label" }, label || ""),
    ),
  );
  addChoiceHelp(root, input, hint, label);
  let errorEl = null;
  const fieldApi = {
    root,
    control: input,
    setError(message) {
      if (message) {
        if (!errorEl) {
          errorEl = el("p", { class: "ecm-field-error ecm-hint-indent", role: "alert" });
          root.append(errorEl);
        }
        errorEl.textContent = String(message);
        root.classList.add("ecm-field-invalid");
      } else if (errorEl) {
        errorEl.remove();
        errorEl = null;
        root.classList.remove("ecm-field-invalid");
      }
    },
    setHint() {},
  };
  if (error) fieldApi.setError(error);
  return fieldApi;
}

function addChoiceHelp(root, input, hint, label) {
  if (!hint) return;
  const help = helpTip(hint, label);
  input.setAttribute("aria-describedby", help.lastElementChild.id);
  root.prepend(el("div", { class: "ecm-field-heading" }, root.firstElementChild, help));
}

export function feedback(message, tone = "info", opts = {}) {
  const root = el("div", {
    class: `ecm-feedback ecm-feedback-${tone}`,
    role: tone === "danger" || tone === "warning" ? "alert" : "status",
  });
  const body = el("div", { class: "ecm-feedback-body" });
  if (message instanceof Node) body.append(message);
  else body.append(el("div", { class: "ecm-feedback-text" }, message === null || message === undefined ? "" : String(message)));
  if (opts.details) {
    const pre = el("pre", { class: "ecm-pre ecm-pre-sm" });
    pre.textContent = formatDetails(opts.details);
    body.append(
      el("details", { class: "ecm-details ecm-details-inline" }, el("summary", null, "详细信息"), pre),
    );
  }
  if (opts.action) body.append(el("div", { class: "ecm-feedback-action" }, opts.action));
  root.append(icon(toneIcon(tone), 16), body);
  return root;
}

export function formatDetails(details) {
  if (details === null || details === undefined) return "";
  if (typeof details === "string") return details;
  if (typeof details === "object" && typeof details.output === "string" && details.output.trim() !== "") {
    return details.output;
  }
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

export function emptyState({ title, body, action, icon: iconName = "inbox" } = {}) {
  const root = el("div", { class: "ecm-empty" });
  root.append(el("div", { class: "ecm-empty-icon" }, icon(iconName, 24)));
  root.append(el("h3", { class: "ecm-empty-title" }, title || "暂无内容"));
  if (body) root.append(el("p", { class: "ecm-empty-body" }, body));
  if (action) root.append(el("div", { class: "ecm-empty-action" }, action));
  return root;
}

export function loadingBlock(message = "加载中…") {
  return el(
    "div",
    { class: "ecm-loading", role: "status", "aria-live": "polite" },
    spinner(18),
    el("span", null, message),
  );
}

export function errorBlock(error, { onRetry, title } = {}) {
  const root = el("div", { class: "ecm-error-block" });
  if (title) root.append(el("h3", { class: "ecm-error-title" }, title));
  root.append(
    feedback(error && error.message ? error.message : String(error || "请求失败"), "danger", {
      details: error && error.details,
      action: onRetry
        ? button("重试", { variant: "secondary", icon: "refresh-cw", onClick: onRetry })
        : null,
    }),
  );
  return root;
}

let toastHost = null;

export function toast(message, tone = "info", opts = {}) {
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el("div", { class: "ecm-toasts", "aria-live": "polite", "aria-atomic": "false" });
    document.body.append(toastHost);
  }
  const item = el("div", {
    class: `ecm-toast ecm-toast-${tone}`,
    role: tone === "danger" ? "alert" : "status",
  });
  const content =
    message instanceof Node
      ? message
      : el("span", { class: "ecm-toast-text" }, message === null || message === undefined ? "" : String(message));
  let removed = false;
  let timer = null;
  const remove = () => {
    if (removed) return;
    removed = true;
    if (timer) clearTimeout(timer);
    item.classList.add("is-leaving");
    setTimeout(() => item.remove(), 140);
  };
  const close = button("", {
    variant: "ghost",
    icon: "x",
    ariaLabel: "关闭通知",
    compact: true,
    className: "ecm-toast-close",
    onClick: remove,
  });
  item.append(icon(toneIcon(tone), 16), content, close);
  toastHost.append(item);
  while (toastHost.children.length > 4) toastHost.firstElementChild.remove();
  timer = setTimeout(remove, opts.duration ?? (tone === "danger" ? 8000 : 4500));
  return remove;
}

export function section(opts = {}) {
  const { title, help, actions, children, flush = false, id, className } = opts;
  const card = el("section", {
    class: `ecm-card${className ? ` ${className}` : ""}`,
    id,
    "aria-labelledby": title ? undefined : undefined,
  });
  if (title || actions) {
    const heading = el(
      "div",
      { class: "ecm-card-heading" },
      title ? el("h2", { class: "ecm-card-title" }, title) : null,
      help ? helpTip(help, title) : null,
    );
    card.append(
      el("div", { class: "ecm-card-head" }, heading, actions ? el("div", { class: "ecm-card-actions" }, actions) : null),
    );
  }
  const body = el("div", { class: `ecm-card-body${flush ? " ecm-card-body-flush" : ""}` });
  appendChildren(body, Array.isArray(children) ? children : [children]);
  card.append(body);
  return card;
}

export function dataTable(opts = {}) {
  const { columns = [], rows = [], onRowClick, label, rowClass, getRowAriaLabel } = opts;
  const wrap = el("div", { class: "ecm-table-wrap" });
  const table = el("table", { class: `ecm-table${onRowClick ? " ecm-table-clickable" : ""}` });
  if (label) table.append(el("caption", { class: "ecm-sr-only" }, label));
  const thead = el("thead");
  const headRow = el("tr");
  for (const column of columns) {
    const classes = [];
    if (column.align) classes.push(`ecm-align-${column.align}`);
    if (column.hideBelow === "sm") classes.push("ecm-col-hide-sm");
    if (column.hideBelow === "md") classes.push("ecm-col-hide-md");
    if (column.width) classes.push("ecm-col-sized");
    const th = el("th", {
      scope: "col",
      class: classes.join(" "),
      style: column.width ? { width: column.width } : undefined,
      title: column.title,
    });
    if (column.label instanceof Node) th.append(column.label);
    else th.textContent = column.label || "";
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = el("tbody");
  rows.forEach((row, index) => {
    const tr = el("tr", { class: rowClass ? rowClass(row, index) : undefined });
    if (onRowClick) {
      tr.tabIndex = 0;
      if (getRowAriaLabel) tr.setAttribute("aria-label", getRowAriaLabel(row, index));
      tr.addEventListener("click", (event) => {
        if (event.target.closest("button, a, input, select, textarea, label, summary")) return;
        onRowClick(row, index, event);
      });
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          if (event.target.closest("button, a, input, select, textarea, label, summary")) return;
          event.preventDefault();
          onRowClick(row, index, event);
        }
      });
    }
    for (const column of columns) {
      const classes = [];
      if (column.align) classes.push(`ecm-align-${column.align}`);
      if (column.hideBelow === "sm") classes.push("ecm-col-hide-sm");
      if (column.hideBelow === "md") classes.push("ecm-col-hide-md");
      if (column.mono) classes.push("ecm-mono");
      const td = el("td", { class: classes.join(" ") });
      const rendered = column.render ? column.render(row, index) : row[column.key];
      if (rendered instanceof Node) td.append(rendered);
      else if (rendered === null || rendered === undefined || rendered === "") td.textContent = "—";
      else td.textContent = String(rendered);
      if (column.title) td.title = column.title(row, index);
      tr.append(td);
    }
    tbody.append(tr);
  });
  table.append(thead, tbody);
  wrap.append(table);
  wrap.tbody = tbody;
  wrap.table = table;
  return wrap;
}

export function tabs(opts = {}) {
  const { items = [], value, onChange, label = "视图切换" } = opts;
  const root = el("div", { class: "ecm-tabs", role: "tablist", "aria-label": label });
  const buttons = new Map();
  const select = (id, focus = false) => {
    for (const [itemId, btn] of buttons) {
      const active = itemId === id;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
      if (active && focus) btn.focus();
    }
    if (onChange) onChange(id);
  };
  for (const item of items) {
    const btn = el(
      "button",
      {
        class: "ecm-tab",
        type: "button",
        role: "tab",
        id: uid("tab"),
        "aria-selected": "false",
        tabindex: "-1",
      },
      item.icon ? icon(item.icon, 16) : null,
      el("span", null, item.label),
    );
    if (item.panel) {
      if (!item.panel.id) item.panel.id = uid("tabpanel");
      btn.setAttribute("aria-controls", item.panel.id);
      item.panel.setAttribute("role", "tabpanel");
      item.panel.setAttribute("aria-labelledby", btn.id);
    }
    btn.addEventListener("click", () => select(item.id));
    btn.addEventListener("keydown", (event) => {
      const ids = items.map((entry) => entry.id);
      const index = ids.indexOf(item.id);
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        select(ids[(index + 1) % ids.length], true);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        select(ids[(index - 1 + ids.length) % ids.length], true);
      } else if (event.key === "Home") {
        event.preventDefault();
        select(ids[0], true);
      } else if (event.key === "End") {
        event.preventDefault();
        select(ids[ids.length - 1], true);
      }
    });
    buttons.set(item.id, btn);
    root.append(btn);
  }
  select(value || (items[0] && items[0].id));
  return { root, select };
}

export function banner(opts = {}) {
  const { tone = "info", title, message, actions, icon: iconName } = opts;
  const root = el("div", { class: `ecm-banner ecm-banner-${tone}` });
  root.append(icon(iconName || toneIcon(tone), 18));
  const content = el("div", { class: "ecm-banner-content" });
  if (title) content.append(el("div", { class: "ecm-banner-title" }, title));
  if (message instanceof Node) content.append(message);
  else if (message) content.append(el("div", { class: "ecm-banner-text" }, String(message)));
  root.append(content);
  if (actions) root.append(el("div", { class: "ecm-banner-actions" }, actions));
  return root;
}

export function statTile({ label, value, hint, tone = "neutral", icon: iconName } = {}) {
  const root = el("div", { class: `ecm-tile ecm-tile-${tone}` });
  const head = el("div", { class: "ecm-tile-head" });
  if (iconName) head.append(icon(iconName, 16));
  head.append(el("span", { class: "ecm-tile-label" }, label || ""));
  root.append(head);
  const valueNode = el("div", { class: "ecm-tile-value ecm-num" });
  if (value instanceof Node) valueNode.append(value);
  else valueNode.textContent = value === null || value === undefined ? "—" : String(value);
  root.append(valueNode);
  if (hint) root.append(el("div", { class: "ecm-tile-hint" }, hint));
  return root;
}

export function metaGrid(items = []) {
  const root = el("dl", { class: "ecm-meta-grid" });
  for (const item of items) {
    const entry = el("div", { class: "ecm-meta" });
    entry.append(el("dt", { class: "ecm-meta-label" }, item.label || ""));
    const dd = el("dd", { class: `ecm-meta-value${item.mono ? " ecm-mono" : ""}${item.tone ? ` ecm-tone-${item.tone}` : ""}` });
    if (item.value instanceof Node) dd.append(item.value);
    else dd.textContent = item.value === null || item.value === undefined || item.value === "" ? "—" : String(item.value);
    if (item.title) dd.title = item.title;
    entry.append(dd);
    root.append(entry);
  }
  return root;
}

export function chips(values = [], opts = {}) {
  const root = el("span", { class: "ecm-chips" });
  const limit = opts.limit || values.length;
  values.slice(0, limit).forEach((value) => {
    root.append(
      el("span", { class: `ecm-chip${opts.mono ? " ecm-mono" : ""}${opts.tone ? ` ecm-chip-${opts.tone}` : ""}` }, String(value)),
    );
  });
  if (values.length > limit) {
    root.append(el("span", { class: "ecm-chip ecm-chip-more", title: values.slice(limit).join(", ") }, `+${values.length - limit}`));
  }
  return root;
}

export function codeBlock(text, opts = {}) {
  const pre = el("pre", { class: `ecm-pre${opts.small ? " ecm-pre-sm" : ""}${opts.mono === false ? "" : " ecm-mono"}` });
  pre.textContent = text === null || text === undefined ? "" : String(text);
  if (opts.maxHeight) pre.style.maxHeight = opts.maxHeight;
  return pre;
}

export function copyButton(text, label = "复制") {
  return button(label, {
    variant: "ghost",
    icon: "copy",
    compact: true,
    onClick: async () => {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(String(text ?? ""));
          toast("已复制到剪贴板", "success");
        } else {
          toast("当前环境不允许访问剪贴板", "warning");
        }
      } catch {
        toast("复制失败", "danger");
      }
    },
  });
}

export function pageHeader(opts = {}) {
  const { title, subtitle, actions, backHref, backLabel = "返回", badges } = opts;
  const root = el("header", { class: "ecm-page-head" });
  const heading = el("div", { class: "ecm-page-heading" });
  if (backHref) {
    heading.append(
      el(
        "a",
        { class: "ecm-back", href: backHref },
        icon("arrow-left", 16),
        el("span", null, backLabel),
      ),
    );
  }
  const titleRow = el("div", { class: "ecm-page-title-row" });
  titleRow.append(el("h1", { class: "ecm-page-title", tabindex: "-1" }, title || ""));
  if (badges) titleRow.append(el("div", { class: "ecm-page-badges" }, badges));
  heading.append(titleRow);
  if (subtitle) heading.append(el("p", { class: "ecm-page-sub" }, subtitle));
  root.append(heading);
  if (actions) root.append(el("div", { class: "ecm-page-actions" }, actions));
  return root;
}

/**
 * Native modal dialog. `actions` accepts descriptors
 * ({label, variant, icon, onClick(dialog)}) or raw button nodes.
 */
export function openDialog(opts = {}) {
  const {
    title,
    body,
    actions = [],
    wide = false,
    drawer = false,
    className,
    initialFocus,
    onClose,
  } = opts;
  const titleId = uid("dialog-title");
  const dialog = el("dialog", {
    class: `ecm-dialog${wide ? " ecm-dialog-wide" : ""}${drawer ? " ecm-drawer" : ""}${className ? ` ${className}` : ""}`,
    "aria-labelledby": titleId,
  });
  const header = el(
    "div",
    { class: "ecm-dialog-header" },
    el("h2", { class: "ecm-dialog-title", id: titleId }, title || ""),
    button("", {
      variant: "ghost",
      icon: "x",
      ariaLabel: "关闭对话框",
      compact: true,
      className: "ecm-dialog-close",
      onClick: () => dialog.close(),
    }),
  );
  const bodyEl = el("div", { class: "ecm-dialog-body" });
  appendChildren(bodyEl, Array.isArray(body) ? body : [body]);
  const footer = el("div", { class: "ecm-dialog-footer" });
  for (const action of actions) {
    if (action instanceof Node) {
      footer.append(action);
      continue;
    }
    footer.append(
      button(action.label, {
        variant: action.variant || "secondary",
        icon: action.icon,
        disabled: action.disabled,
        type: action.type || "button",
        onClick: () => {
          if (action.onClick) action.onClick(dialog);
          else dialog.close(action.value || "");
        },
      }),
    );
  }
  if (actions.length === 0) footer.remove();
  dialog.append(header, bodyEl, footer);
  const previousFocus = document.activeElement;
  let closed = false;
  dialog.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    dialog.remove();
    if (previousFocus && typeof previousFocus.focus === "function" && document.contains(previousFocus)) {
      try {
        previousFocus.focus();
      } catch {
        // Ignore focus restoration failures.
      }
    }
    if (onClose) onClose(dialog.returnValue);
  });
  document.body.append(dialog);
  dialog.showModal();
  const focusInitial = () => {
    if (!dialog.open) return;
    let target = typeof initialFocus === "function" ? initialFocus() : initialFocus;
    if (!target && typeof initialFocus === "string") target = dialog.querySelector(initialFocus);
    if (!target) target = dialog.querySelector("input:not([type=hidden]), select, textarea");
    if (!target) target = footer.querySelector("button");
    if (!target) target = header.querySelector("button");
    if (target && typeof target.focus === "function") target.focus();
  };
  // Apply focus immediately (showModal focuses the first focusable element) and
  // once more after layout so dialogs always start on the safe action.
  focusInitial();
  requestAnimationFrame(focusInitial);
  return { dialog, body: bodyEl, footer, close: (value) => dialog.close(value ?? "") };
}

export function confirmDialog(opts = {}) {
  const {
    title = "确认操作",
    message,
    confirmLabel = "确认",
    cancelLabel = "取消",
    danger = false,
    details,
    wide = false,
  } = opts;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = el("div", { class: "ecm-dialog-message" });
    appendChildren(body, Array.isArray(message) ? message : [message]);
    if (details) {
      const pre = el("pre", { class: "ecm-pre ecm-pre-sm" });
      pre.textContent = formatDetails(details);
      body.append(el("details", { class: "ecm-details ecm-details-inline" }, el("summary", null, "详细信息"), pre));
    }
    const cancelBtn = button(cancelLabel, { variant: "secondary" });
    const confirmBtn = button(confirmLabel, { variant: danger ? "danger" : "primary" });
    const handle = openDialog({
      title,
      body,
      actions: [cancelBtn, confirmBtn],
      wide,
      initialFocus: () => cancelBtn,
      onClose: () => finish(false),
    });
    cancelBtn.addEventListener("click", () => {
      finish(false);
      handle.close("cancel");
    });
    confirmBtn.addEventListener("click", () => {
      finish(true);
      handle.close("confirm");
    });
  });
}

/**
 * Resolve a save conflict: "disk" reloads the server copy, "overwrite" retries
 * with force, "cancel" leaves the editor as-is. Cancel receives initial focus.
 */
export function conflictDialog({ title = "检测到外部修改", message, details, overwriteLabel = "强制覆盖" } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const body = el("div", { class: "ecm-dialog-message" });
    if (Array.isArray(message)) appendChildren(body, message);
    else if (message) body.append(el("p", null, String(message)));
    body.append(
      el(
        "p",
        { class: "ecm-dialog-emphasis" },
        "「以磁盘为准」会载入磁盘上的当前内容并丢弃本地修改；「强制覆盖」会用本地内容覆盖磁盘。",
      ),
    );
    if (details) {
      const pre = el("pre", { class: "ecm-pre ecm-pre-sm" });
      pre.textContent = formatDetails(details);
      body.append(el("details", { class: "ecm-details ecm-details-inline" }, el("summary", null, "详细信息"), pre));
    }
    const cancelBtn = button("取消", { variant: "secondary" });
    const diskBtn = button("以磁盘为准", { variant: "secondary", icon: "download" });
    const overwriteBtn = button(overwriteLabel, { variant: "danger", icon: "upload" });
    const handle = openDialog({
      title,
      body,
      actions: [cancelBtn, diskBtn, overwriteBtn],
      initialFocus: () => cancelBtn,
      onClose: () => finish("cancel"),
    });
    cancelBtn.addEventListener("click", () => {
      finish("cancel");
      handle.close();
    });
    diskBtn.addEventListener("click", () => {
      finish("disk");
      handle.close();
    });
    overwriteBtn.addEventListener("click", () => {
      finish("overwrite");
      handle.close();
    });
  });
}

export function diffView(oldText, newText) {
  const lines = diffLines(oldText, newText);
  const stats = diffStats(lines);
  const root = el("div", { class: "ecm-diff-window" });
  root.append(
    el(
      "div",
      { class: "ecm-diff-summary" },
      el("span", { class: "ecm-diff-add-count" }, `+${stats.added}`),
      el("span", { class: "ecm-diff-del-count" }, `−${stats.removed}`),
    ),
  );
  if (stats.added === 0 && stats.removed === 0) {
    root.append(emptyState({ title: "没有差异", body: "编辑器内容与基线完全一致。", icon: "check-circle" }));
    return root;
  }
  const list = el("div", { class: "ecm-diff", role: "region", "aria-label": "行级差异" });
  for (const line of lines) {
    const typeClass = line.type === "add" ? "ecm-diff-add" : line.type === "del" ? "ecm-diff-del" : "ecm-diff-same";
    const prefix = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
    list.append(
      el(
        "div",
        { class: `ecm-diff-line ${typeClass}` },
        el("span", { class: "ecm-diff-lineno" }, line.oldLine === null ? "" : String(line.oldLine)),
        el("span", { class: "ecm-diff-lineno" }, line.newLine === null ? "" : String(line.newLine)),
        el("span", { class: "ecm-diff-prefix", "aria-hidden": "true" }, prefix),
        el("span", { class: "ecm-diff-text" }, line.text === "" ? " " : line.text),
      ),
    );
  }
  root.append(list);
  return root;
}

export function showDiff({ title = "差异对比", oldText, newText, leftLabel = "基线", rightLabel = "当前编辑" }) {
  const content = diffView(oldText, newText);
  content.prepend(
    el(
      "div",
      { class: "ecm-diff-labels" },
      el("span", null, leftLabel),
      icon("arrow-right", 14),
      el("span", null, rightLabel),
    ),
  );
  const closeBtn = button("关闭", { variant: "secondary" });
  const handle = openDialog({
    title,
    body: content,
    actions: [closeBtn],
    wide: true,
    initialFocus: () => closeBtn,
  });
  closeBtn.addEventListener("click", () => handle.close());
}

/**
 * Code editor for raw Caddyfile content with validate / fmt / diff / save.
 * The component owns its baseline and retries with force after a 409 conflict.
 */
export function rawEditor(opts = {}) {
  const {
    value = "",
    baseline,
    maxBytes = 48 * 1024,
    disabled: initialDisabled = false,
    disabledReason = "",
    saveLabel = "保存原文",
    saveVariant = "primary",
    saveInHeader = false,
    placeholder = "",
    validateName = "片段",
    onValidate,
    onFormat,
    onSave,
    onSaved,
    onBeforeSave,
    onDirtyChange,
    onConflictReload,
    onBusyChange,
  } = opts;

  let base = typeof baseline === "string" ? baseline : String(value || "");
  let current = String(value || "");
  let dirty = false;
  let busy = false;
  let disabledState = Boolean(initialDisabled);

  const textarea = el("textarea", {
    class: "ecm-control ecm-textarea ecm-code-input",
    rows: "18",
    spellcheck: "false",
    placeholder,
    disabled: disabledState,
    "aria-label": "Caddyfile 原文",
  });
  textarea.value = current;

  const counter = el("span", { class: "ecm-hint ecm-counter" });
  const statusArea = el("div", { class: "ecm-editor-status", "aria-live": "polite" });

  const validateBtn = button("校验", {
    variant: "secondary",
    icon: "check-circle",
    compact: true,
    disabled: disabledState || !onValidate,
    onClick: () => validate(),
  });
  const fmtBtn = button("格式化", {
    variant: "secondary",
    icon: "sparkles",
    compact: true,
    disabled: disabledState || !onFormat,
    onClick: () => format(),
  });
  const diffBtn = button("差异", {
    variant: "secondary",
    icon: "git-compare",
    compact: true,
    disabled: disabledState,
    onClick: () => showDiff({ oldText: base, newText: current, leftLabel: "上次基线" }),
  });
  const saveBtn = button(saveLabel, {
    variant: saveVariant,
    icon: "save",
    compact: !saveInHeader,
    disabled: disabledState,
    onClick: () => save(false),
  });

  const toolbar = el(
    "div",
    { class: "ecm-editor-toolbar" },
    el("div", { class: "ecm-editor-tools" }, validateBtn, fmtBtn, diffBtn),
    el("div", { class: "ecm-editor-actions" }, counter, saveInHeader ? null : saveBtn),
  );

  const root = el("div", { class: "ecm-raw-editor" });
  if (disabledState && disabledReason) root.append(feedback(disabledReason, "warning"));
  root.append(toolbar, textarea, statusArea);

  const updateCounter = () => {
    const bytes = byteLength(current);
    counter.textContent = `${fmtBytes(bytes)} / ${fmtBytes(maxBytes)}`;
    counter.classList.toggle("ecm-tone-danger", bytes > maxBytes);
  };

  const setDirty = (next) => {
    const changed = Boolean(next);
    if (dirty === changed) return;
    dirty = changed;
    if (onDirtyChange) onDirtyChange(dirty);
  };

  const refreshDirty = () => {
    setDirty(current !== base);
  };

  const setBusy = (next) => {
    busy = next;
    textarea.disabled = disabledState || busy;
    if (onBusyChange) onBusyChange(busy);
    validateBtn.disabled = disabledState || busy || !onValidate;
    fmtBtn.disabled = disabledState || busy || !onFormat;
    diffBtn.disabled = disabledState || busy;
    if (next) {
      buttonBusy(saveBtn, true, "保存中…");
    } else {
      buttonBusy(saveBtn, false);
      saveBtn.disabled = disabledState || !onSave;
    }
  };

  const clearStatus = () => statusArea.replaceChildren();
  const showStatus = (node) => statusArea.replaceChildren(node);

  async function validate() {
    if (!onValidate || busy || disabledState) return;
    clearStatus();
    buttonBusy(validateBtn, true, "校验中…");
    try {
      const data = await onValidate(current);
      const bytes = data && Number.isFinite(Number(data.bytes)) ? Number(data.bytes) : byteLength(current);
      showStatus(feedback(`${validateName}校验通过（${fmtBytes(bytes)}）。`, "success"));
    } catch (error) {
      showStatus(feedback(error.message || "校验失败", "danger", { details: error.details }));
    } finally {
      buttonBusy(validateBtn, false);
      validateBtn.disabled = disabledState || !onValidate;
    }
  }

  async function format() {
    if (!onFormat || busy || disabledState) return;
    clearStatus();
    const before = current;
    buttonBusy(fmtBtn, true, "格式化中…");
    try {
      const data = await onFormat(before);
      if (current !== before || busy || disabledState) return;
      if (data && typeof data.formatted === "string" && data.formatted !== current) {
        current = data.formatted;
        textarea.value = current;
        updateCounter();
        refreshDirty();
        showStatus(feedback(data.changed === false ? "格式无需改变。" : "已格式化，保存后生效。", "success"));
      } else {
        showStatus(feedback("格式无需改变。", "success"));
      }
    } catch (error) {
      showStatus(feedback(error.message || "格式化失败", "danger", { details: error.details }));
    } finally {
      buttonBusy(fmtBtn, false);
      fmtBtn.disabled = disabledState || busy || !onFormat;
    }
  }

  async function save(force) {
    if (!onSave || busy || disabledState) return;
    const bytes = byteLength(current);
    if (bytes > maxBytes) {
      showStatus(feedback(`内容超过上限（${fmtBytes(maxBytes)}），请精简后再保存。`, "danger"));
      return;
    }
    if (onBeforeSave) {
      const allowed = await onBeforeSave();
      if (!allowed) return;
    }
    clearStatus();
    const sent = current;
    setBusy(true);
    try {
      let response;
      try {
        response = await onSave(sent, base, Boolean(force));
      } catch (error) {
        if (error?.code !== "conflict" || force) throw error;
        const choice = await conflictDialog({
          title: "检测到外部修改",
          message: error.message || "磁盘上的内容已与基线不同。",
          details: error.details,
        });
        if (choice === "disk") {
          if (onConflictReload) await onConflictReload();
          else showStatus(feedback("请刷新页面以载入磁盘内容。", "warning"));
          return;
        }
        if (choice !== "overwrite") return;
        response = await onSave(sent, base, true);
      }
      base = sent;
      refreshDirty();
      const message =
        response && response.apply && response.apply.message
          ? response.apply.message
          : "已保存。";
      showStatus(feedback(message, "success"));
      if (onSaved) await onSaved(response, sent);
    } catch (error) {
      showStatus(feedback(error.message || "保存失败", "danger", { details: error.details }));
    } finally {
      setBusy(false);
    }
  }

  textarea.addEventListener("input", () => {
    current = textarea.value;
    updateCounter();
    refreshDirty();
    clearStatus();
  });

  updateCounter();
  if (disabledState) {
    validateBtn.disabled = true;
    fmtBtn.disabled = true;
    diffBtn.disabled = true;
    saveBtn.disabled = true;
  }

  return {
    root,
    saveButton: saveBtn,
    getValue: () => current,
    setValue(next) {
      current = String(next || "");
      textarea.value = current;
      updateCounter();
      refreshDirty();
    },
    getBaseline: () => base,
    setBaseline(next) {
      base = String(next || "");
      refreshDirty();
    },
    markClean() {
      base = current;
      dirty = false;
      if (onDirtyChange) onDirtyChange(false);
    },
    setDisabled(next) {
      disabledState = Boolean(next);
      textarea.disabled = disabledState || busy;
      validateBtn.disabled = disabledState || busy || !onValidate;
      fmtBtn.disabled = disabledState || busy || !onFormat;
      diffBtn.disabled = disabledState || busy;
      saveBtn.disabled = disabledState || busy;
    },
    isDirty: () => dirty,
    focus: () => textarea.focus(),
  };
}

/**
 * Polling log viewer. Polling runs only while started, visible in the viewport,
 * and the document is visible. Every request is abortable on teardown.
 */
export function logViewer(opts = {}) {
  const {
    scope,
    slug = "",
    defaultLines = 500,
    showStatus = false,
    showHost = false,
  } = opts;

  const state = {
    paused: false,
    autoScroll: true,
    q: "",
    lines: Number(defaultLines) || 500,
    status: "",
    includeAccess: false,
    active: false,
    visible: typeof IntersectionObserver === "undefined",
    destroyed: false,
    inFlight: false,
    timer: null,
    filterTimer: null,
    controller: null,
    lastUpdated: null,
    error: null,
    entries: [],
    note: null,
    fetchedOnce: false,
  };

  const output = el("div", {
    class: "ecm-log-output",
    tabindex: "0",
    role: "region",
    "aria-label": "日志内容",
    "aria-live": "off",
  });
  output.append(loadingBlock("正在读取日志…"));

  const statusEl = el("span", { class: "ecm-log-status", "aria-live": "polite" }, "尚未加载");
  const qInput = el("input", {
    class: "ecm-control ecm-control-compact",
    type: "search",
    placeholder: "关键字过滤",
    "aria-label": "日志关键字过滤",
    autocomplete: "off",
  });
  qInput.addEventListener("input", () => {
    clearTimeout(state.filterTimer);
    state.filterTimer = setTimeout(() => {
      state.q = qInput.value.trim();
      refreshNow(true);
    }, 300);
  });

  const linesSelect = el("select", {
    class: "ecm-control ecm-control-compact",
    "aria-label": "日志行数",
  });
  let configuredLines = Number(state.lines);
  if (!Number.isInteger(configuredLines) || configuredLines < 100 || configuredLines > 2000) {
    configuredLines = 500;
  }
  const lineOptions = [100, 500, 1000, 2000];
  if (!lineOptions.includes(configuredLines)) {
    lineOptions.push(configuredLines);
    lineOptions.sort((a, b) => a - b);
  }
  for (const lines of lineOptions) {
    linesSelect.append(el("option", { value: String(lines) }, `${lines} 行`));
  }
  state.lines = configuredLines;
  linesSelect.value = String(configuredLines);

  let statusSelect = null;
  if (showStatus) {
    statusSelect = el("select", {
      class: "ecm-control ecm-control-compact",
      "aria-label": "状态码过滤",
    });
    statusSelect.append(el("option", { value: "" }, "全部状态"));
    statusSelect.append(el("option", { value: "4xx" }, "全部 4xx"), el("option", { value: "5xx" }, "全部 5xx"));
    for (const code of [101, 200, 201, 204, 206, 301, 302, 304, 307, 308, 400, 401, 403, 404, 405, 408, 409, 429, 500, 502, 503, 504]) {
      statusSelect.append(el("option", { value: String(code) }, String(code)));
    }
  }

  let includeAccess = null;
  if (scope === "service") {
    const input = el("input", { type: "checkbox", class: "ecm-check-input", id: uid("log-access") });
    includeAccess = { input, label: el("label", { class: "ecm-check ecm-check-inline", for: input.id }, input, el("span", { class: "ecm-check-box", "aria-hidden": "true" }, icon("check", 12)), el("span", { class: "ecm-check-label" }, "包含访问日志")) };
    input.addEventListener("change", () => {
      state.includeAccess = input.checked;
      refreshNow();
    });
  }

  const pauseBtn = button("暂停", {
    variant: "secondary",
    icon: "pause",
    compact: true,
    onClick: () => togglePause(),
  });

  const autoScrollInput = el("input", { type: "checkbox", class: "ecm-check-input", id: uid("log-scroll"), checked: true });
  autoScrollInput.addEventListener("change", () => {
    state.autoScroll = autoScrollInput.checked;
    if (state.autoScroll) output.scrollTop = output.scrollHeight;
  });

  const exportLink = el(
    "a",
    {
      class: "ecm-btn ecm-btn-ghost ecm-btn-compact",
      href: api.exportUrl({ scope, slug: scope === "site" ? slug : undefined, lines: state.lines }),
      download: "",
    },
    icon("download", 16),
    el("span", { class: "ecm-btn-label" }, "导出"),
  );

  const updateExportLink = () => {
    exportLink.href = api.exportUrl({ scope, slug: scope === "site" ? slug : undefined, lines: state.lines });
  };

  linesSelect.addEventListener("change", () => {
    state.lines = Number(linesSelect.value);
    updateExportLink();
    refreshNow(true);
  });
  if (statusSelect) {
    statusSelect.addEventListener("change", () => {
      state.status = statusSelect.value;
      refreshNow(true);
    });
  }

  const controls = el(
    "div",
    { class: "ecm-log-toolbar" },
    el(
      "div",
      { class: "ecm-log-controls" },
      pauseBtn,
      el(
        "label",
        { class: "ecm-check ecm-check-inline", for: autoScrollInput.id },
        autoScrollInput,
        el("span", { class: "ecm-check-box", "aria-hidden": "true" }, icon("check", 12)),
        el("span", { class: "ecm-check-label" }, "自动滚动"),
      ),
      qInput,
      statusSelect,
      linesSelect,
      includeAccess ? includeAccess.label : null,
      exportLink,
    ),
    statusEl,
  );

  const summary = scope === "site" ? el("div", { class: "ecm-stack" }, el("h3", null, "近期访问摘要")) : null;
  const root = el("div", { class: "ecm-log" }, summary, controls, output);

  let lastSummary;
  function renderSummary(data) {
    if (!summary || !data) return;
    const serialized = JSON.stringify(data);
    if (lastSummary === serialized) return;
    lastSummary = serialized;
    const focusedClass = summary.contains(document.activeElement) && document.activeElement.dataset.logStatus;

    const coverage = {
      window: "已读取当前可见 Journal 窗口。",
      line_limit: "达到所选行数上限。增大行数可查看更早的记录。",
      truncated: "达到 64 KiB 读取上限，仅统计最新的完整日志行。",
      empty: "当前 Journal 窗口为空。访问站点后重试，并确认日志输出到 Journal。",
      restricted: "Journal 读取权限不足。可见记录可能不完整，请检查宿主账号的读取权限。",
      unavailable: "Journal 不可用。请检查 journalctl、服务单元及宿主权限。",
      unsupported: "本站的配置原文无法可靠归属到结构化入口。请在配置中核对日志输出和格式。",
    }[data.coverage];
    const filter = (label, code, count) => {
      const control = button(`${label} ${count}`, {
        compact: true,
        onClick: () => {
          statusSelect.value = code;
          statusSelect.dispatchEvent(new Event("change"));
          statusSelect.focus();
        },
      });
      control.dataset.logStatus = code;
      return control;
    };
    const windowText = data.start && data.finish
      ? `${fmtDateTime(data.start, { seconds: true })} 至 ${fmtDateTime(data.finish, { seconds: true })}`
      : "暂无可见时间";
    const retryable = data.coverage === "unavailable" || (data.coverage === "restricted" && !data.journalLines);
    const unavailable = retryable || data.coverage === "unsupported";
    summary.replaceChildren(
      el("h3", null, "近期访问摘要"),
      el("p", { class: "ecm-hint" },
        `${windowText} · ${data.journalLines || 0} / ${data.requestedLines} 行 · ${coverage}`),
      retryable ? button("重试日志读取", { compact: true, icon: "refresh-cw", onClick: () => refreshNow(true) }) : null,
      unavailable ? null : metaGrid([
        { label: "匹配请求", value: data.requests },
        { label: "平均响应耗时", value: data.durationSamples ? `${fmtDurationMs(data.meanMs)}（${data.durationSamples} 条）` : "—" },
      ]),
      unavailable ? null : el("div", { class: "ecm-inline ecm-wrap", role: "group", "aria-label": "按状态分类筛选日志" },
        filter("4xx", "4xx", data.clientErrors), filter("5xx", "5xx", data.serverErrors)),
      unavailable ? null : el("p", { class: "ecm-hint" }, "统计本站可识别的 Journal 访问记录，范围为整个窗口。文件、其他输出及无法识别的记录不计入。"),
    );
    if (focusedClass) summary.querySelector(`[data-log-status="${focusedClass}"]`)?.focus({ preventScroll: true });
  }
  let observer = null;
  let visibilityCheck = null;

  const clearTimer = () => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  };

  const abortInFlight = () => {
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
    }
  };

  const shouldPoll = () =>
    state.active && state.visible && !state.paused && !state.destroyed && !state.fatalError && !document.hidden;

  const schedule = (delay = 1000) => {
    clearTimer();
    if (!shouldPoll()) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      poll();
    }, delay);
  };

  const refreshNow = (explicit = false) => {
    abortInFlight();
    clearTimer();
    state.inFlight = false;
    state.fatalError = false;
    if (explicit && state.paused) poll(true);
    else if (shouldPoll()) schedule(0);
  };

  const updateStatusText = () => {
    const parts = [];
    if (state.paused) parts.push("已暂停");
    if (state.lastUpdated) {
      parts.push(`更新于 ${fmtLogTime(state.lastUpdated.getTime())}`);
    }
    if (state.fetchedOnce && Array.isArray(state.entries)) {
      parts.push(`${state.entries.length} 条`);
    }
    if (state.error) parts.push("加载失败");
    statusEl.textContent = parts.length ? parts.join(" · ") : "尚未加载";
  };

  const renderEmpty = () => {
    if (state.note) {
      output.replaceChildren(feedback(state.note, "info"));
    } else {
      output.replaceChildren(
        emptyState({
          title: "暂无日志",
          body:
            scope === "site"
              ? "当前窗口内没有匹配该站点域名的访问日志。可以增大行数或稍后再试。"
              : "当前窗口内没有日志行。",
          icon: "terminal",
        }),
      );
    }
  };

  const renderEntries = () => {
    const previousTop = output.scrollTop;
    if (!Array.isArray(state.entries) || state.entries.length === 0) {
      renderEmpty();
      updateStatusText();
      return;
    }
    if (scope === "site") {
      const table = el("table", { class: "ecm-table ecm-log-table" });
      table.append(
        el(
          "thead",
          null,
          el(
            "tr",
            null,
            el("th", { scope: "col" }, "时间"),
            el("th", { scope: "col" }, "状态"),
            el("th", { scope: "col" }, "请求"),
            showHost ? el("th", { scope: "col" }, "主机") : null,
            el("th", { scope: "col" }, "耗时"),
            el("th", { scope: "col" }, "客户端"),
            el("th", { scope: "col", class: "ecm-col-hide-md" }, "User-Agent"),
          ),
        ),
      );
      const tbody = el("tbody");
      for (const entry of state.entries) {
        const status = Number(entry.status) || 0;
        tbody.append(
          el(
            "tr",
            null,
            el("td", { class: "ecm-mono ecm-nowrap" }, fmtLogTime(entry.time)),
            el("td", null, badge(String(status || "—"), httpStatusTone(status))),
            el(
              "td",
              { class: "ecm-mono ecm-log-request" },
              el("span", { class: "ecm-log-method" }, entry.method || "—"),
              el("span", { class: "ecm-log-uri", title: entry.uri || "" }, entry.uri || ""),
            ),
            showHost ? el("td", { class: "ecm-mono" }, entry.host || "—") : null,
            el("td", { class: "ecm-num ecm-nowrap" }, fmtDurationMs(entry.durationMs)),
            el("td", { class: "ecm-mono ecm-nowrap" }, entry.remoteIp || "—"),
            el("td", { class: "ecm-col-hide-md" }, el("span", { class: "ecm-truncate", title: entry.userAgent || "" }, entry.userAgent || "—")),
          ),
        );
      }
      table.append(tbody);
      const wrap = el("div", { class: "ecm-log-table-wrap" }, table);
      output.replaceChildren(wrap);
    } else {
      const list = el("div", { class: "ecm-log-lines" });
      for (const entry of state.entries) {
        const line = el("div", { class: `ecm-log-line${entry.access ? " ecm-log-line-access" : ""}` });
        line.append(el("span", { class: "ecm-log-time ecm-mono" }, fmtLogTime(entry.time)));
        line.append(el("span", { class: "ecm-log-msg ecm-mono" }, entry.message || ""));
        if (entry.access) line.append(el("span", { class: "ecm-log-badge" }, badge("访问", "info")));
        list.append(line);
      }
      output.replaceChildren(list);
    }
    if (state.autoScroll) output.scrollTop = output.scrollHeight;
    else output.scrollTop = previousTop;
    updateStatusText();
  };

  const renderError = (error) => {
    output.replaceChildren(
      feedback(error.message || "日志读取失败", "danger", {
        details: error.details,
        action: button("重试", { variant: "secondary", icon: "refresh-cw", compact: true, onClick: refreshNow }),
      }),
    );
    updateStatusText();
  };

  async function poll(explicit = false) {
    if ((!explicit && !shouldPoll()) || state.inFlight) {
      schedule(1000);
      return;
    }
    state.inFlight = true;
    const controller = new AbortController();
    state.controller = controller;
    try {
      let data;
      if (scope === "site") {
        const statusClass = /^[45]xx$/.test(state.status) ? state.status[0] : undefined;
        data = await api.logsSite({
          slug,
          lines: state.lines,
          q: state.q || undefined,
          status: statusClass ? undefined : state.status || undefined,
          statusClass,
          signal: controller.signal,
        });
      } else {
        data = await api.logsService({
          lines: state.lines,
          q: state.q || undefined,
          includeAccess: state.includeAccess,
        });
      }
      if (state.destroyed || controller.signal.aborted) return;
      renderSummary(data?.summary);
      state.entries = Array.isArray(data && data.entries) ? data.entries : [];
      state.note = (data && data.note) || (state.entries.length ? null : {
        unavailable: "日志不可用，请根据上方覆盖说明重试。",
        restricted: "没有可显示的站点记录，请核对上方的权限说明。",
        unsupported: "无法显示此配置的站点访问日志。",
      }[data?.summary?.coverage]);
      state.error = null;
      state.fatalError = ["unavailable", "unsupported"].includes(data?.summary?.coverage)
        || (data?.summary?.coverage === "restricted" && !data.summary.journalLines);
      state.lastUpdated = new Date();
      state.fetchedOnce = true;
      renderEntries();
    } catch (error) {
      if (error && error.name === "AbortError") return;
      if (state.destroyed) return;
      state.error = error;
      // Pause polling on a backend or network error until the user retries.
      const permanent = ["journal_unavailable", "service_error", "host_error", "network_error"].includes(
        error && error.code,
      ) || (error && error.status === 503);
      state.fatalError = permanent;
      renderError(error);
    } finally {
      if (state.controller === controller) {
        state.controller = null;
        state.inFlight = false;
        updateStatusText();
        if (!state.destroyed && !state.fatalError) schedule(scope === "site" ? 4000 : 1000);
      }
    }
  }

  function togglePause() {
    state.paused = !state.paused;
    pauseBtn.replaceChildren(
      icon(state.paused ? "play" : "pause", 16),
      el("span", { class: "ecm-btn-label" }, state.paused ? "继续" : "暂停"),
    );
    pauseBtn.classList.toggle("is-active", state.paused);
    if (state.paused) {
      clearTimer();
      if (visibilityCheck) clearTimeout(visibilityCheck);
      visibilityCheck = null;
      abortInFlight();
      state.inFlight = false;
      updateStatusText();
    } else {
      onViewportChange();
      updateStatusText();
      refreshNow();
      scheduleVisibilityCheck();
    }
  }

  const isInViewport = () => {
    if (!root.isConnected) return false;
    const rect = root.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < height;
  };

  const scheduleVisibilityCheck = () => {
    if (visibilityCheck) clearTimeout(visibilityCheck);
    visibilityCheck = null;
    if (!state.active || state.destroyed || state.paused || state.visible || document.hidden) return;
    visibilityCheck = setTimeout(() => {
      visibilityCheck = null;
      if (!state.active || state.destroyed || state.paused || state.visible || document.hidden) return;
      onViewportChange();
      if (!state.visible) scheduleVisibilityCheck();
    }, 400);
  };

  const setVisible = (visible) => {
    if (state.visible === visible) return;
    state.visible = visible;
    if (visible) {
      if (visibilityCheck) clearTimeout(visibilityCheck);
      visibilityCheck = null;
      if (state.active) schedule(0);
    } else {
      clearTimer();
      abortInFlight();
      state.inFlight = false;
      scheduleVisibilityCheck();
    }
  };

  const onViewportChange = () => {
    if (state.destroyed) return;
    setVisible(isInViewport());
  };

  const onVisibility = () => {
    if (document.hidden) {
      clearTimer();
      if (visibilityCheck) clearTimeout(visibilityCheck);
      visibilityCheck = null;
      abortInFlight();
      state.inFlight = false;
    } else if (state.active) {
      onViewportChange();
      schedule(0);
      scheduleVisibilityCheck();
    }
  };
  const onPageHide = () => {
    clearTimer();
    abortInFlight();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("scroll", onViewportChange, { passive: true, capture: true });
  window.addEventListener("resize", onViewportChange);

  if (typeof IntersectionObserver !== "undefined") {
    observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "120px" },
    );
    observer.observe(root);
  }

  return {
    root,
    start() {
      if (state.destroyed) return;
      state.active = true;
      refreshNow();
      // Guard against missed IntersectionObserver/scroll updates (for example
      // when a drawer opens or layout shifts without a scroll event).
      scheduleVisibilityCheck();
    },
    stop() {
      state.active = false;
      clearTimer();
      if (visibilityCheck) clearTimeout(visibilityCheck);
      visibilityCheck = null;
      abortInFlight();
      state.inFlight = false;
      updateStatusText();
    },
    refresh: refreshNow,
    destroy() {
      state.destroyed = true;
      clearTimer();
      if (visibilityCheck) clearTimeout(visibilityCheck);
      if (state.filterTimer) clearTimeout(state.filterTimer);
      abortInFlight();
      if (observer) observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      root.remove();
    },
    isPaused: () => state.paused,
  };
}
