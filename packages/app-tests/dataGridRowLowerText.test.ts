import { strict as assert } from "node:assert";
import { test } from "vitest";
import { createRowLowerTextCache } from "../../apps/desktop/src/lib/dataGrid/dataGridRowLowerText.ts";
import type { CellValue } from "../../apps/desktop/src/lib/dataGrid/cellValue.ts";

test("memoizes lowercase text per cell across repeated full scans", () => {
  let formatCalls = 0;
  const cache = createRowLowerTextCache((value) => {
    formatCalls++;
    return String(value);
  });
  const rows: CellValue[][] = Array.from({ length: 1000 }, (_, i) => [i, `Name-${i}`, `MAIL${i}@X.COM`]);

  // 第一遍全量扫描：每格格式化一次
  for (const row of rows) for (let col = 0; col < 3; col++) cache.get(row, col);
  assert.equal(formatCalls, 3000);
  assert.equal(cache.get(rows[0]!, 2), "mail0@x.com");

  // 第二遍相同顺序扫描：必须全部命中（固定容量 LRU 在此场景会零命中）
  for (const row of rows) for (let col = 0; col < 3; col++) cache.get(row, col);
  assert.equal(formatCalls, 3000);
});

test("recomputes only the edited cell after in-place mutation", () => {
  let formatCalls = 0;
  const cache = createRowLowerTextCache((value) => {
    formatCalls++;
    return String(value);
  });
  const row: CellValue[] = ["A", "B"];
  assert.equal(cache.get(row, 0), "a");
  assert.equal(cache.get(row, 1), "b");
  assert.equal(formatCalls, 2);

  // 保存后原地写回单元格：仅该格重算
  row[0] = "Changed";
  assert.equal(cache.get(row, 0), "changed");
  assert.equal(cache.get(row, 1), "b");
  assert.equal(formatCalls, 3);
});

test("clear() invalidates everything (formatter/column-type changes)", () => {
  let formatCalls = 0;
  const cache = createRowLowerTextCache((value) => {
    formatCalls++;
    return String(value);
  });
  const row: CellValue[] = ["X"];
  cache.get(row, 0);
  cache.clear();
  cache.get(row, 0);
  assert.equal(formatCalls, 2);
});
