// Formatting helpers shared by every view. All output is plain Chinese UI text;
// dates are shown in the viewer's local timezone.

const pad = (value) => String(value).padStart(2, "0");

/** Parse RFC3339, journald short-iso, epoch seconds or epoch milliseconds. */
export function toDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = Math.abs(value) < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return null;
    if (/^\d+(\.\d+)?$/.test(text)) return toDate(Number(text));
    // systemctl show formats timestamps as "Fri 2026-11-21 10:00:00 CST".
    const systemd = text.match(
      /^[A-Za-z]{3}\s+(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\s+([A-Za-z0-9+/-]+))?$/,
    );
    if (systemd) {
      const year = Number(systemd[1]);
      const month = Number(systemd[2]) - 1;
      const day = Number(systemd[3]);
      const hour = Number(systemd[4]);
      const minute = Number(systemd[5]);
      const second = Number(systemd[6]);
      const zone = systemd[7] || "";
      const date = /^(UTC|GMT)$/i.test(zone)
        ? new Date(Date.UTC(year, month, day, hour, minute, second))
        : new Date(year, month, day, hour, minute, second);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    // journalctl -o short-iso emits "+0800"; normalize the offset for Date().
    const normalized = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Local absolute date-time, e.g. 2026-11-25 13:04:07. */
export function fmtDateTime(value, { seconds = false } = {}) {
  const date = toDate(value);
  if (!date) return "—";
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
  return seconds ? `${base}:${pad(date.getSeconds())}` : base;
}

/** Compact log stamp: time-of-day today, date + time otherwise. */
export function fmtLogTime(value) {
  const date = toDate(value);
  if (!date) {
    return typeof value === "string" && value !== "" ? value : "—";
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

/** "3 分钟前" / "2 天后"; falls back to an absolute date for far values. */
export function fmtRelative(value, now = Date.now()) {
  const date = toDate(value);
  if (!date) return "—";
  const diffMs = date.getTime() - (now instanceof Date ? now.getTime() : Number(now));
  const future = diffMs > 0;
  const abs = Math.abs(diffMs) / 1000;
  if (abs < 45) return "刚刚";
  let amount;
  let unit;
  if (abs < 3600) {
    amount = Math.max(1, Math.round(abs / 60));
    unit = "分钟";
  } else if (abs < 86400) {
    amount = Math.max(1, Math.round(abs / 3600));
    unit = "小时";
  } else if (abs < 86400 * 30) {
    amount = Math.max(1, Math.round(abs / 86400));
    unit = "天";
  } else if (abs < 86400 * 365) {
    amount = Math.max(1, Math.round(abs / (86400 * 30)));
    unit = "个月";
  } else {
    amount = Math.max(1, Math.round(abs / (86400 * 365)));
    unit = "年";
  }
  return future ? `${amount} ${unit}后` : `${amount} ${unit}前`;
}

const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });

/** "12.4 ms" / "1.3 s" / "2 分 5 秒". */
export function fmtDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${numberFormat.format(ms)} ms`;
  if (ms < 60000) return `${numberFormat.format(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** Convert host.services cpuUsageNs into a readable duration. */
export function fmtCpuTime(value) {
  const ns = Number(value);
  if (!Number.isFinite(ns) || ns <= 0) return "—";
  return fmtDurationMs(ns / 1e6);
}

/** 0 B / 512 B / 1.2 KiB / 3.4 MiB. */
export function fmtBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const digits = amount >= 100 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

/** Days remaining; negative means expired. */
export function fmtDays(value) {
  if (value === null || value === undefined || value === "") return "—";
  const days = Number(value);
  if (!Number.isFinite(days)) return "—";
  if (days < 0) return `已过期 ${Math.abs(Math.round(days))} 天`;
  if (days === 0) return "今天到期";
  return `${Math.round(days)} 天`;
}

export function statusTone(state) {
  switch (String(state || "").toLowerCase()) {
    case "running":
    case "active":
      return "success";
    case "failed":
    case "error":
      return "danger";
    case "restarting":
    case "deactivating":
      return "warning";
    case "completed":
      return "info";
    case "stopped":
    case "inactive":
      return "neutral";
    default:
      return "neutral";
  }
}

export function statusLabel(state) {
  switch (String(state || "").toLowerCase()) {
    case "running":
    case "active":
      return "运行中";
    case "stopped":
    case "inactive":
      return "已停止";
    case "failed":
      return "失败";
    case "completed":
      return "已结束";
    case "restarting":
      return "重启中";
    case "deactivating":
      return "停止中";
    case "unknown":
    case "":
      return "未知";
    default:
      return String(state);
  }
}

export function certTone(days, error) {
  if (error) return "neutral";
  if (days === null || days === undefined) return "neutral";
  const value = Number(days);
  if (!Number.isFinite(value)) return "neutral";
  if (value <= 14) return "danger";
  if (value <= 30) return "warning";
  return "success";
}

export function httpStatusTone(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return "neutral";
  if (code >= 500) return "danger";
  if (code >= 400) return "warning";
  if (code >= 300) return "info";
  if (code >= 200) return "success";
  return "neutral";
}

export function typeLabel(type) {
  switch (type) {
    case "static":
      return "静态站点";
    case "proxy":
      return "反向代理";
    case "redirect":
      return "重定向";
    case "custom":
      return "自定义片段";
    default:
      return type ? String(type) : "未知";
  }
}

export function lbPolicyLabel(policy) {
  switch (policy) {
    case "round_robin":
      return "轮询";
    case "least_conn":
      return "最少连接";
    case "random":
      return "随机";
    case "ip_hash":
      return "IP 哈希";
    case "uri_hash":
      return "URI 哈希";
    case "first":
      return "首个可用";
    default:
      return policy || "轮询";
  }
}

/** Tiny plural helper kept for call sites that need a unit label. */
export function plural(count, one, many) {
  return Number(count) === 1 ? one : many;
}

/** Deterministic byte length for config limits (UTF-8). */
export function byteLength(text) {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(String(text ?? "")).length;
  }
  return unescape(encodeURIComponent(String(text ?? ""))).length;
}

/**
 * Line diff with LCS. Returns [{type:"same"|"add"|"del",text,oldLine,newLine}].
 * Falls back to a coarse block diff when the matrix would be too large.
 */
export function diffLines(oldText, newText) {
  const oldSource = String(oldText ?? "");
  const newSource = String(newText ?? "");
  const oldLines = oldSource === "" ? [] : oldSource.split("\n");
  const newLines = newSource === "" ? [] : newSource.split("\n");
  // Drop a single trailing empty line so a final newline does not add noise.
  if (oldLines.length > 1 && oldLines[oldLines.length - 1] === "") oldLines.pop();
  if (newLines.length > 1 && newLines[newLines.length - 1] === "") newLines.pop();

  const rows = oldLines.length;
  const cols = newLines.length;
  if (rows * cols > 1500000) {
    let prefix = 0;
    while (prefix < rows && prefix < cols && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < rows - prefix &&
      suffix < cols - prefix &&
      oldLines[rows - 1 - suffix] === newLines[cols - 1 - suffix]
    ) {
      suffix += 1;
    }
    const result = [];
    for (let i = 0; i < prefix; i += 1) {
      result.push({ type: "same", text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
    }
    for (let i = prefix; i < rows - suffix; i += 1) {
      result.push({ type: "del", text: oldLines[i], oldLine: i + 1, newLine: null });
    }
    for (let i = prefix; i < cols - suffix; i += 1) {
      result.push({ type: "add", text: newLines[i], oldLine: null, newLine: i + 1 });
    }
    for (let s = suffix; s > 0; s -= 1) {
      const oldIndex = rows - s;
      const newIndex = cols - s;
      result.push({
        type: "same",
        text: oldLines[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
      });
    }
    return result;
  }

  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const result = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "same", text: oldLines[i], oldLine: i + 1, newLine: j + 1 });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      result.push({ type: "del", text: oldLines[i], oldLine: i + 1, newLine: null });
      i += 1;
    } else {
      result.push({ type: "add", text: newLines[j], oldLine: null, newLine: j + 1 });
      j += 1;
    }
  }
  while (i < rows) {
    result.push({ type: "del", text: oldLines[i], oldLine: i + 1, newLine: null });
    i += 1;
  }
  while (j < cols) {
    result.push({ type: "add", text: newLines[j], oldLine: null, newLine: j + 1 });
    j += 1;
  }
  return result;
}

export function diffStats(lines) {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === "add") added += 1;
    else if (line.type === "del") removed += 1;
  }
  return { added, removed };
}
