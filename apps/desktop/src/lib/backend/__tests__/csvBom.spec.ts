// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { exportQueryResultCsv } from "@/lib/backend/http";
afterEach(() => vi.restoreAllMocks());
it.each([false, true])("exports CSV with csvWithoutBom=%s", async (withoutBom) => {
  let saved: Blob | undefined;
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    saved = blob as Blob;
    return "blob:csv";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await exportQueryResultCsv("export.csv", ["id", "name"], [[1, "中文"]], "all", undefined, withoutBom);
  const bytes = new Uint8Array(await saved!.arrayBuffer());
  expect(Array.from(bytes.slice(0, 3))).toEqual(withoutBom ? [34, 105, 100] : [239, 187, 191]);
  expect(new TextDecoder().decode(bytes)).toContain('"id","name"');
  expect(new TextDecoder().decode(bytes)).toContain("中文");
});
