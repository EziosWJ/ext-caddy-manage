import { button, codeBlock, confirmDialog, conflictDialog, diffView, el, icon, openDialog } from "../components.js";

export function savedEditorMode(key) {
  try {
    return localStorage.getItem(key) === "raw" ? "raw" : "form";
  } catch {
    return "form";
  }
}

export function rememberEditorMode(key, mode) {
  try {
    if (mode === "raw") localStorage.setItem(key, mode);
    else localStorage.removeItem(key);
  } catch {
    // The active editor remains usable when browser storage is disabled.
  }
}

export function viewConfiguration(title, content) {
  openDialog({
    title,
    body: codeBlock(content, { maxHeight: "60vh" }),
    actions: [{ label: "关闭" }],
    wide: true,
  });
}

export function configurationToolbar({ raw, canEditForm, view, switchMode }) {
  return el(
    "div", { class: "ecm-config-toolbar" },
    el("span", { class: "ecm-config-mode" }, raw ? "原文编辑" : "表单编辑"),
    el("div", { class: "ecm-toolbar" },
      !raw ? button("查看原文", { icon: "eye", variant: "ghost", compact: true, onClick: view }) : null,
      canEditForm ? button(raw ? "切换到表单" : "编辑原文", {
        variant: "secondary", compact: true, onClick: switchMode,
      }) : null,
    ),
  );
}

export async function saveReviewedForm({ baseline, review, preview, save, reload, confirmLabel }) {
  async function confirmChanges(current) {
    const { content } = await preview(current);
    return confirmDialog({
      title: "确认表单将写入的配置",
      message: [
        el("div", { class: "ecm-diff-labels" },
          el("span", null, "当前磁盘文件"), icon("arrow-right", 14), el("span", null, "表单生成结果")),
        diffView(current, content),
      ],
      confirmLabel,
      danger: true,
      wide: true,
    });
  }

  if (review && !(await confirmChanges(baseline))) return null;
  try {
    return await save(baseline);
  } catch (error) {
    const current = error?.details?.current;
    if (error?.code !== "conflict" || typeof current !== "string") throw error;
    const choice = await conflictDialog({
      message: "磁盘内容已更新。可以载入磁盘文件，或查看表单将覆盖的差异。",
      overwriteLabel: "查看差异",
    });
    if (choice === "disk") await reload();
    if (choice !== "overwrite" || !(await confirmChanges(current))) return null;
    return save(current);
  }
}
