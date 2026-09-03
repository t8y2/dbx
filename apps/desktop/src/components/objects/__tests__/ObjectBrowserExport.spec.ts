import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ObjectBrowser.vue", import.meta.url), "utf8");

function functionBody(name: string): string {
  const signature = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\{`, "m").exec(source);
  if (!signature) throw new Error(`Missing function ${name}`);
  const bodyStart = signature.index + signature[0].length;
  let depth = 1;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(bodyStart, index);
  }
  throw new Error(`Unclosed function ${name}`);
}

describe("ObjectBrowser XLSX export", () => {
  it("asks for export options before opening the save dialog", () => {
    const dialog = functionBody("showObjectBrowserXlsxHeaderDialog");
    const exportDataXlsx = functionBody("exportDataXlsx");

    expect(dialog).toContain("showHeaderOptions: hasComments");
    expect(exportDataXlsx).toContain("hasXlsxHeaderComments(columnInfos?.map((column) => column.comment))");
    expect(exportDataXlsx.indexOf("await showObjectBrowserXlsxHeaderDialog(")).toBeLessThan(exportDataXlsx.indexOf('await exportTableData(row, "xlsx", columnInfos, exportOptions.headerMode, exportOptions.autoFilter)'));
  });

  it("falls back to field-name headers when column metadata is unavailable", () => {
    const exportDataXlsx = functionBody("exportDataXlsx");

    expect(exportDataXlsx).toContain("catch {\n    // Export still works with field-name headers when column metadata is unavailable.\n  }");
    expect(exportDataXlsx).toContain('await exportTableData(row, "xlsx", columnInfos, exportOptions.headerMode, exportOptions.autoFilter)');
  });
});
