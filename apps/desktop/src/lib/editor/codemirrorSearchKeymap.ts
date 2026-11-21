import type { KeyBinding } from "@codemirror/view";

/**
 * `@codemirror/search` 的 `searchKeymap` 内置硬编码了 `Mod-d` = `selectNextOccurrence`
 * （多光标选择下一个匹配词），与 DBX 的可配置快捷键体系冲突：
 *
 * - DBX 中 `Mod+D` 默认绑定「复制行 / 复制当前行」等用户可配置动作（见 shortcutRegistry.ts）；
 *   一旦用户把 `Mod+D` 配置给其他动作（例如把「新建查询」改为 Ctrl+D），searchKeymap 的
 *   `Mod-d` 会在编辑器中抢先匹配并 `preventDefault`，事件冒泡到 window 时
 *   `defaultPrevented=true`，App.vue 的全局 handleKeydown 直接返回，用户配置的快捷键永不触发。
 *
 * 这里移除 `Mod-d` 绑定，保证用户可配置的快捷键优先于 CodeMirror 内置硬编码键位
 * （与 #4544 修复 Mod+F / Mod+H 冲突的思路一致）。
 */
/**
 * #14623: `searchKeymap` 内置的 `Mod-f` = `openSearchPanel` 同样遮蔽了用户可配置的
 * Find 快捷键——清空 Find 后编辑器仍会打开搜索面板并吞掉事件，全局 Focus search
 * 无法触发。过滤逻辑泛化为按键集合。
 */
export function searchKeymapWithoutModD(searchKeymap: readonly KeyBinding[]): KeyBinding[] {
  return stripKeys(searchKeymap, ["Mod-d", "Mod-f"]);
}

function stripKeys(searchKeymap: readonly KeyBinding[], keys: readonly string[]): KeyBinding[] {
  return searchKeymap.filter((binding) => binding.key === undefined || !keys.includes(binding.key));
}
