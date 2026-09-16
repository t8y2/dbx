import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// 能打开「导入表数据」向导的三个入口。侧边栏的守卫在菜单宿主（SidebarTreeRuntimeHost.vue）里，
// 写入函数 composables/useSidebarTreeToolRuntime.ts 本身不带守卫，所以这里列的是入口界面而不是写入点。
const TABLE_IMPORT_ENTRY_SURFACES = ["../ContentArea.vue", "../../objects/ObjectBrowser.vue", "../../sidebar/SidebarTreeRuntimeHost.vue"];

describe("ContentArea table import entry", () => {
  it("gates the data-tab toolbox import item on the shared capability check", () => {
    const source = read("../ContentArea.vue");
    // HANA 的能力清单是 tableImport:false。入口不跟能力走时，向导仍能打开并停在「选项」步：
    // 目标表字段元数据取不回来，下一步恒为禁用（QA #hana-import 的复现路径）。
    expect(source).toContain("const canOpenTableImport = computed(");
    expect(source).toContain("supportsTableImport(activeEffectiveDatabaseType.value)");

    const item = source.indexOf('t("tableToolbox.importData")');
    expect(item).toBeGreaterThan(-1);
    const openTag = source.lastIndexOf("<DropdownMenuItem", item);
    expect(openTag).toBeGreaterThan(-1);
    expect(source.slice(openTag, item)).toContain('v-if="canOpenTableImport"');
  });

  it("keeps every entry surface consulting the same capability", () => {
    for (const surface of TABLE_IMPORT_ENTRY_SURFACES) {
      expect(read(surface), surface).toContain("supportsTableImport");
    }
  });
});
