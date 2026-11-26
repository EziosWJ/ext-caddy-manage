import { button, chips, el, icon, inputField, selectField, switchField, textareaField } from "../components.js";

const MATCHES = [{ value: "exact", label: "精确路径" }, { value: "prefix", label: "按段前缀" }];
const ACTIONS = [
  { value: "preserve", label: "保留路径" },
  { value: "strip", label: "剥离匹配前缀" },
  { value: "rewrite", label: "重写为固定路径" },
];
const FALLBACKS = [
  { value: "proxy", label: "反向代理" },
  { value: "static", label: "静态文件" },
  { value: "404", label: "返回 404" },
];

const lines = (value) => value.split("\n").map((part) => part.trim()).filter(Boolean);
const newRule = () => ({ match: "prefix", path: "", action: "preserve", rewrite: "", proxy: { upstreams: [] } });

export function routingDraft(source, proxy) {
  if (!source) {
    return {
      rules: [newRule()],
      fallback: { type: proxy.upstreams.length ? "proxy" : "404", proxy: structuredClone(proxy) },
    };
  }
  return structuredClone(source);
}

export function routingModel(draft) {
  const rules = draft.rules.map((rule) => ({
    match: rule.match,
    path: rule.path.trim(),
    action: rule.action,
    ...(rule.action === "rewrite" ? { rewrite: rule.rewrite?.trim() || "" } : {}),
    proxy: rule.proxy,
  }));
  const fallback = { type: draft.fallback.type };
  if (fallback.type === "proxy") fallback.proxy = draft.fallback.proxy;
  if (fallback.type === "static") {
    fallback.static = { ...draft.fallback.static, root: draft.fallback.static.root.trim() };
  }
  return { rules, fallback };
}

export function routingEditor(draft, { active, toggle, change, policies }) {
  const fields = {};
  const enabled = switchField({
    label: "按路径转发",
    checked: active,
    hint: "精确路径优先，其次匹配最长按段前缀。访问控制覆盖所有分支。",
    onChange: toggle,
  });
  const editor = el("div", { class: "ecm-stack", hidden: !active });
  const root = el("div", { class: "ecm-stack" }, enabled.root, editor);
  fields.routing = enabled;
  fields["routing.rules"] = enabled;
  if (!active) return { root, fields };

  const ruleList = el("div", { class: "ecm-stack" });
  const fallbackTarget = el("div", { class: "ecm-form-grid" });
  const preview = el("div", { class: "ecm-stack" });
  const request = inputField({
    label: "请求路径示例",
    hint: "预览命中的分支和发往上游的路径。保留原查询串。",
    value: "/api/users?page=1",
    mono: true,
    onInput: updatePreview,
  });
  const add = button("添加路径规则", {
    icon: "plus",
    onClick: () => {
      if (draft.rules.length >= 20) return;
      draft.rules.push(newRule());
      renderRules();
      fields[`routing.rules.${draft.rules.length}.path`].control.focus();
      changed();
    },
  });
  const fallback = selectField({
    label: "未匹配路径",
    options: FALLBACKS,
    value: draft.fallback.type,
    onChange: (value) => {
      draft.fallback.type = value;
      renderFallback();
      changed();
    },
  });
  fields["routing.fallback"] = fallback;
  fields["routing.fallback.type"] = fallback;
  editor.append(ruleList, add, fallback.root, fallbackTarget, request.root, preview);

  function changed() {
    change();
    updatePreview();
  }

  function pool(target, field) {
    const upstreams = textareaField({
      label: "代理池上游",
      hint: "每行一个 host:port、[IPv6]:port 或带 http(s) 的地址。",
      value: target.upstreams.join("\n"),
      rows: 2,
      mono: true,
      onInput: (value) => {
        target.upstreams = lines(value);
        changed();
      },
    });
    const policy = selectField({
      label: "负载均衡",
      options: policies,
      value: target.lbPolicy || "round_robin",
      onChange: (value) => {
        target.lbPolicy = value;
        changed();
      },
    });
    fields[`${field}.upstreams`] = upstreams;
    fields[`${field}.lbPolicy`] = policy;
    return [upstreams.root, policy.root];
  }

  function renderRules() {
    for (const key of Object.keys(fields)) {
      if (key.startsWith("routing.rules.")) delete fields[key];
    }
    ruleList.replaceChildren();
    draft.rules.forEach((rule, index) => {
      const number = index + 1;
      const field = `routing.rules.${number}`;
      const match = selectField({
        label: "匹配方式",
        options: MATCHES,
        value: rule.match,
        onChange: (value) => {
          rule.match = value;
          updateActions();
          changed();
        },
      });
      const path = inputField({
        label: "匹配路径",
        value: rule.path,
        placeholder: "/api",
        mono: true,
        onInput: (value) => {
          rule.path = value;
          updateActions();
          changed();
        },
      });
      const action = selectField({
        label: "上游请求路径",
        options: ACTIONS,
        value: rule.action,
        onChange: (value) => {
          rule.action = value;
          updateActions();
          changed();
        },
      });
      const rewrite = inputField({
        label: "固定重写路径",
        placeholder: "/v1/users",
        value: rule.rewrite || "",
        mono: true,
        onInput: (value) => {
          rule.rewrite = value;
          changed();
        },
      });
      function updateActions() {
        const canStrip = rule.match === "prefix" && rule.path.trim() !== "/";
        action.control.querySelector('option[value="strip"]').disabled = !canStrip;
        if (!canStrip && rule.action === "strip") {
          rule.action = "preserve";
          action.control.value = "preserve";
        }
        rewrite.root.hidden = rule.action !== "rewrite";
      }
      updateActions();
      for (const [key, input] of Object.entries({ match, path, action, rewrite })) fields[`${field}.${key}`] = input;

      const remove = button("移除", {
        variant: "danger-ghost",
        icon: "trash",
        compact: true,
        ariaLabel: `移除路径规则 ${number}`,
        onClick: () => {
          draft.rules.splice(index, 1);
          renderRules();
          const focus = fields[`routing.rules.${Math.min(number, draft.rules.length)}.path`]?.control ?? add;
          focus.focus();
          changed();
        },
      });
      ruleList.append(el("div", { class: "ecm-route-rule", role: "group", "aria-label": `路径规则 ${number}` },
        el("div", { class: "ecm-route-rule-head" },
          el("span", { class: "ecm-route-rule-title" },
            el("span", { class: "ecm-route-badge" }, `#${number}`),
            el("span", null, `路径规则 ${number}`),
          ),
          remove,
        ),
        el("div", { class: "ecm-route-rule-body" },
          el("div", { class: "ecm-form-grid" }, match.root, path.root, action.root, rewrite.root, ...pool(rule.proxy, `${field}.proxy`)),
        ),
      ));
    });
    add.disabled = draft.rules.length >= 20;
  }

  function renderFallback() {
    for (const key of Object.keys(fields)) {
      if (key.startsWith("routing.fallback.proxy.") || key.startsWith("routing.fallback.static.")) delete fields[key];
    }
    const target = draft.fallback;
    fallbackTarget.replaceChildren();
    if (target.type === "proxy") {
      target.proxy ??= { upstreams: [] };
      fallbackTarget.append(...pool(target.proxy, "routing.fallback.proxy"));
    } else if (target.type === "static") {
      target.static ??= { root: "", browse: false, spa: false };
      const directory = inputField({
        label: "静态根目录",
        value: target.static.root,
        placeholder: "/srv/www",
        mono: true,
        onInput: (value) => {
          target.static.root = value;
          changed();
        },
      });
      const spa = switchField({
        label: "SPA 回退",
        checked: target.static.spa,
        hint: "在静态分支内把不存在的路径交给 /index.html。",
        onChange: (value) => {
          target.static.spa = value;
          changed();
        },
      });
      const browse = switchField({
        label: "目录浏览",
        checked: target.static.browse,
        onChange: (value) => {
          target.static.browse = value;
          changed();
        },
      });
      fields["routing.fallback.static.root"] = directory;
      fallbackTarget.append(directory.root, spa.root, browse.root);
    }
    fallbackTarget.hidden = !fallbackTarget.childElementCount;
  }

  function updatePreview(value = request.control.value) {
    const queryStart = value.indexOf("?");
    const path = queryStart < 0 ? value : value.slice(0, queryStart);
    const query = queryStart < 0 ? "" : value.slice(queryStart);
    const model = routingModel(draft);
    const ordered = model.rules.filter((rule) => rule.path.startsWith("/")).sort((a, b) =>
      a.match === b.match ? b.path.length - a.path.length : a.match === "exact" ? -1 : 1
    );
    const match = ordered.find((rule) => path === rule.path
      || (rule.match === "prefix" && path.startsWith(rule.path === "/" ? "/" : rule.path + "/")));
    let route;
    if (!path.startsWith("/")) {
      preview.replaceChildren(el("p", { class: "ecm-hint" }, "输入以 / 开头的路径。"));
      return;
    }
    if (match) {
      const next = match.action === "rewrite" ? match.rewrite
        : match.action === "strip" ? path.slice(match.path.length) || "/" : path;
      route = { branch: match.path, destination: next + query, pool: match.proxy.upstreams };
    } else {
      route = {
        branch: FALLBACKS.find(({ value: type }) => type === model.fallback.type).label,
        destination: model.fallback.type === "404" ? "—" : path + query,
        pool: model.fallback.proxy?.upstreams ?? [],
      };
    }
    preview.replaceChildren(
      el("div", { class: "ecm-route-flow", role: "region", "aria-label": "请求路由预览" },
        el("div", { class: "ecm-route-flow-node" },
          el("span", { class: "ecm-route-flow-label" }, "命中分支"),
          el("span", { class: "ecm-chip ecm-chip-info ecm-mono" }, route.branch),
        ),
        icon("arrow-right", 15),
        el("div", { class: "ecm-route-flow-node" },
          el("span", { class: "ecm-route-flow-label" }, "处理路径"),
          el("span", { class: "ecm-chip ecm-mono" }, route.destination),
        ),
        icon("arrow-right", 15),
        el("div", { class: "ecm-route-flow-node" },
          el("span", { class: "ecm-route-flow-label" }, "目标上游"),
          route.pool.length ? chips(route.pool, { mono: true, limit: 3 }) : el("span", { class: "ecm-hint" }, "—"),
        ),
      ),
    );
  }

  renderRules();
  renderFallback();
  updatePreview();
  return { root, fields };
}
