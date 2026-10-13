import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

// #11787：录入组合键期间不得执行对应命令，靠的是「焦点元素落在快捷键录入表面上时，
// 所有 capture 阶段的全局快捷键处理器都让路」。capture 跑在目标元素处理器之前，无法
// 依赖 defaultPrevented，只能按焦点判定——因此这里钉住每条 capture 分支都用了同一个
// 判定（isShortcutEditingTarget），避免以后新增分支时漏掉一条。
//
// 该判定本身的行为由 apps/desktop/src/lib/__tests__/editor/shortcutRecorder.spec.ts
// 覆盖（每行录入框 / SQL 录入框 / 录入按钮），这里只钉接线。

const app = readFileSync("apps/desktop/src/App.vue", "utf8");
const shortcutRecorder = readFileSync("apps/desktop/src/lib/editor/shortcutRecorder.ts", "utf8");

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${signature}`);
  return source.slice(start, end);
}

test("the shared editing-surface predicate covers the record-keys button", () => {
  assert.match(shortcutRecorder, /export const SHORTCUT_EDITING_TARGET_SELECTOR = "[^"]*\[data-shortcut-recorder\][^"]*"/);
  assert.match(shortcutRecorder, /export function isShortcutEditingTarget\(/);
});

test("every capture-phase shortcut guard bails on a shortcut-editing surface", () => {
  // 快速打开 / 全局搜索 + 修饰键双敲。
  assert.match(functionBody(app, "function canCaptureModifierDoubleTapSearch("), /isShortcutEditingTarget\(target\)/);
  assert.match(functionBody(app, "function handleGlobalSearchKeydownCapture("), /isShortcutEditingTarget\(target\)/);
  // 焦点搜索键默认就是 Mod+F：不在这里让路，录入 Ctrl+F 会被抢走焦点并中断录入。
  const auxiliarySearch = functionBody(app, "function handleAuxiliarySearchKeydownCapture(");
  assert.match(auxiliarySearch, /isShortcutEditingTarget\(target\)/);
  assert.ok(auxiliarySearch.indexOf("isShortcutEditingTarget(target)") < auxiliarySearch.indexOf("focusSearchInAuxiliarySurface(target)"), "the guard must bail out before moving focus into another surface");
});

test("the per-row and SQL shortcut inputs keep sharing that predicate", () => {
  const selector = shortcutRecorder.match(/export const SHORTCUT_EDITING_TARGET_SELECTOR = "([^"]*)"/)?.[1] ?? "";
  for (const attribute of ["[data-shortcut-input]", "[data-sql-shortcut-input]", "[data-shortcut-recorder]"]) {
    assert.ok(selector.includes(attribute), `selector must still cover ${attribute}`);
  }
  // 没有第二条内联选择器绕开这个判定（#11787 把它统一成一个常量）。
  assert.doesNotMatch(app, /closest\("\[data-shortcut-input\]/);
});
