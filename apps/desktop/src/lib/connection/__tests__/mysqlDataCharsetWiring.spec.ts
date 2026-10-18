import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { translateBackendError } from "@/i18n/backend-errors";
import en from "@/i18n/locales/en";
import zhCN from "@/i18n/locales/zh-CN";
import zhTW from "@/i18n/locales/zh-TW";
import ja from "@/i18n/locales/ja";
import es from "@/i18n/locales/es";
import itLocale from "@/i18n/locales/it";
import ptBR from "@/i18n/locales/pt-BR";
import az from "@/i18n/locales/az";
import id from "@/i18n/locales/id";
import ko from "@/i18n/locales/ko";
import ru from "@/i18n/locales/ru";
import th from "@/i18n/locales/th";
import tr from "@/i18n/locales/tr";

const source = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("MySQL legacy compatibility UI contracts", () => {
  it("binds the native MySQL selector to persisted URL params and leaves Firebird separate", () => {
    const dialog = source("components/connection/ConnectionDialog.vue");
    expect(dialog).toContain('v-if="supportsMysqlDataCharset(form)"');
    expect(dialog).toContain('v-model="mysqlDataCharsetValue"');
    expect(dialog).toContain("setMysqlDataCharset(form.value.url_params, value)");
    expect(dialog).toContain("mysqlDataCharsetValidation(config)");
    expect(dialog).toContain('v-model="firebirdDataCharset"');
    expect(dialog).toContain("connection.firebirdDataCharsetHint");
  });
  it("threads effective readonly into editing, exports and the status badge", () => {
    const grid = source("components/grid/DataGrid.vue");
    expect(grid).toContain("const effectiveEditable = computed(() => !!props.editable && !compatibilityReadOnly.value)");
    expect(grid).toContain("editable: computed(() => effectiveEditable.value)");
    expect(grid).toContain("mysqlDataCharsetReadOnly: compatibilityReadOnly");
    expect(grid).toContain("connection.mysqlDataCharsetExportHint");
    expect(source("components/connection/ReadOnlySessionControl.vue")).toContain("if (compatibilityReadOnly.value) return;");
  });
  it("explains constraints in every locale and translates core policy errors", () => {
    const keys = ["mysqlDataCharset", "mysqlDataCharsetHint", "mysqlDataCharsetReadOnly", "mysqlDataCharsetExportHint", "mysqlDataCharsetInvalid", "mysqlDataCharsetConflict", "mysqlDataCharsetCloseTabs", "mysqlDataCharsetUnsupported"] as const;
    for (const locale of [en, zhCN, zhTW, ja, es, itLocale, ptBR, az, id, ko, ru, th, tr]) {
      for (const key of keys) expect(locale.connection[key]).toBeTruthy();
      for (const key of ["largeValuePendingDecode", "largeValueOriginalKeyUnavailable", "largeValuePendingDecodeExport"] as const) expect(locale.grid[key]).toBeTruthy();
    }
    expect(translateBackendError((key) => key, "MYSQL_DATA_CHARSET_READ_ONLY: no writes")).toBe("connection.mysqlDataCharsetReadOnly");
    expect(translateBackendError((key) => key, "MYSQL_DATA_CHARSET_EXPORT_UNSUPPORTED: sql")).toBe("connection.mysqlDataCharsetExportHint");
  });
  it("uses the same pending-aware formatter for canvas and DOM grid cells", () => {
    const grid = source("components/grid/DataGrid.vue");
    expect(grid).toContain("formatCell: (_value, columnIndex, row) => formatGridItemCell(row, columnIndex, false)");
    expect(grid).toContain("gridCellDisplayValue(formatGridItemCell(item, col.actualColIdx)");
  });
  it("blocks backup and both ends of transfer, including locally loaded query results", () => {
    const backup = source("components/export/DatabaseExportDialog.vue");
    expect(backup).toContain("if (mysqlDataCharsetEnabled(store.getConfig(connectionId.value))) return false;");
    const transfer = source("components/transfer/DataTransferDialog.vue");
    expect(transfer).toContain("mysqlDataCharsetEnabled(store.getConfig(sourceConnectionId.value)) || mysqlDataCharsetEnabled(store.getConfig(targetConnectionId.value))");
    const resultTransfer = source("components/transfer/QueryResultTransferDialog.vue");
    expect(resultTransfer).toContain("mysqlDataCharsetEnabled(connections.getConfig(props.sourceConnectionId)) || mysqlDataCharsetEnabled(targetConfig.value)");
    expect(resultTransfer).toContain("if (compatibilityBlocked.value) return;");
    expect(source("components/objects/ObjectBrowser.vue")).toContain('format === "sql" && mysqlDataCharsetEnabled(props.connection)');
    expect(source("composables/useSidebarTreeExportRuntime.ts")).toContain('format === "sql" && targets.some((target) => mysqlDataCharsetEnabled(connectionStore.getConfig(target.connectionId)))');
  });
});
