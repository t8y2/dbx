import { describe, expect, it } from "vitest";
import {
  collectForeignKeyDisplayValues,
  createForeignKeyDisplayRequestCoordinator,
  foreignKeyDisplayConfigMatches,
  foreignKeyDisplayLookupRequestKey,
  foreignKeyDisplayMapFromResult,
  formatForeignKeyDisplayValue,
  singleColumnForeignKey,
  splitForeignKeyDisplayValues,
} from "@/lib/dataGrid/dataGridForeignKeyDisplay";
import { buildColumnForeignKeyMap } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { QueryResult } from "@/types/database";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("dataGridForeignKeyDisplay", () => {
  it("only enables dictionary display for a single-column foreign key", () => {
    const single = buildColumnForeignKeyMap([{ name: "fk_user", column: "user_id", ref_schema: "public", ref_table: "users", ref_column: "id" }]).get("user_id");
    const composite = buildColumnForeignKeyMap([
      { name: "fk_item", column: "order_id", ref_table: "items", ref_column: "order_id" },
      { name: "fk_item", column: "line_no", ref_table: "items", ref_column: "line_no" },
    ]).get("order_id");

    expect(singleColumnForeignKey(single)?.ref_table).toBe("users");
    expect(singleColumnForeignKey(composite)).toBeUndefined();
  });

  it("matches a saved configuration against current foreign-key metadata", () => {
    const config = { kind: "foreign-key-display" as const, refSchema: "public", refTable: "users", refColumn: "id", displayColumn: "name" };
    expect(foreignKeyDisplayConfigMatches(config, { name: "fk_user", column: "user_id", ref_schema: "PUBLIC", ref_table: "USERS", ref_column: "ID" })).toBe(true);
    expect(foreignKeyDisplayConfigMatches(config, { name: "fk_user", column: "user_id", ref_schema: "public", ref_table: "accounts", ref_column: "id" })).toBe(false);
    expect(foreignKeyDisplayConfigMatches(config, { name: "fk_user", column: "user_id", ref_schema: "archive", ref_table: "users", ref_column: "id" })).toBe(false);
  });

  it("deduplicates current-page keys with type-safe identities and bounded batches", () => {
    const rows = [[100], [100], ["100"], [null], [101], [{ id: 1 }]] as QueryResult["rows"];
    const values = collectForeignKeyDisplayValues(rows, 0);
    expect(values).toEqual([100, "100", 101]);
    expect(splitForeignKeyDisplayValues(values, 2)).toEqual([[100, "100"], [101]]);
  });

  it("caps a large page at 2000 unique values and four 500-value batches", () => {
    const rows = Array.from({ length: 2500 }, (_, index) => [index]) as QueryResult["rows"];
    const values = collectForeignKeyDisplayValues(rows, 0);
    const batches = splitForeignKeyDisplayValues(values);

    expect(values).toHaveLength(2000);
    expect(batches).toHaveLength(4);
    expect(batches.every((batch) => batch.length === 500)).toBe(true);
  });

  it("builds labels from query results and preserves raw values when no useful label exists", () => {
    const result = {
      columns: ["id", "name", "code"],
      rows: [
        [100, "张三", "U100"],
        [101, "李四", "U101"],
        [102, null, "U102"],
        [103, "  ", "U103"],
        [100, "重复", "U100-duplicate"],
      ],
    } as QueryResult;
    const labels = foreignKeyDisplayMapFromResult(result);
    const codeLabels = foreignKeyDisplayMapFromResult(result, "ID", "CODE");

    expect(formatForeignKeyDisplayValue(100, labels)).toBe("100 (张三)");
    expect(formatForeignKeyDisplayValue(102, labels)).toBe("102");
    expect(formatForeignKeyDisplayValue(103, labels)).toBe("103");
    expect(formatForeignKeyDisplayValue(null, labels)).toBe("NULL");
    expect(formatForeignKeyDisplayValue("same", new Map([["string\u0000same", "same"]]))).toBe("same");
    expect(formatForeignKeyDisplayValue(100, codeLabels)).toBe("100 (U100)");
    expect(foreignKeyDisplayMapFromResult(result, "missing", "code")).toEqual(new Map());
  });

  it("deduplicates in-flight requests and reuses the bounded cache across generations", async () => {
    const coordinator = createForeignKeyDisplayRequestCoordinator({ concurrency: 2 });
    const gate = deferred<number>();
    const generation = coordinator.beginGeneration();
    let calls = 0;
    const task = () => {
      calls += 1;
      return gate.promise;
    };
    const requestScope = { connectionId: "c1", database: "db", schema: "public", table: "users", refColumn: "id", displayColumn: "name" };
    const firstKey = foreignKeyDisplayLookupRequestKey({ ...requestScope, values: [100, "100"] });
    const reorderedKey = foreignKeyDisplayLookupRequestKey({ ...requestScope, values: ["100", 100] });
    expect(reorderedKey).toBe(firstKey);

    const first = coordinator.request(generation, firstKey, task);
    const duplicate = coordinator.request(generation, reorderedKey, task);
    expect(calls).toBe(1);
    gate.resolve(7);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([7, 7]);

    const nextGeneration = coordinator.beginGeneration();
    await expect(coordinator.request(nextGeneration, firstKey, async () => 8)).resolves.toBe(7);
    expect(calls).toBe(1);
    coordinator.dispose();
  });

  it("enforces one concurrency limit across many configured-column batches", async () => {
    const coordinator = createForeignKeyDisplayRequestCoordinator({ concurrency: 2 });
    const generation = coordinator.beginGeneration();
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const requests = Array.from({ length: 12 }, (_, index) =>
      coordinator.request(generation, `column-batch-${index}`, async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return index;
      }),
    );

    await expect(Promise.all(requests)).resolves.toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(calls).toBe(12);
    expect(maxActive).toBe(2);
    coordinator.dispose();
  });

  it("cancels stale queued work and prevents old-page results after rapid page switches", async () => {
    const coordinator = createForeignKeyDisplayRequestCoordinator({ concurrency: 2 });
    const oldGate = deferred<void>();
    const oldGeneration = coordinator.beginGeneration();
    let oldStarted = 0;
    let newStarted = 0;
    let active = 0;
    let maxActive = 0;
    const oldRequests = Array.from({ length: 8 }, (_, index) =>
      coordinator.request(oldGeneration, `old-${index}`, async () => {
        oldStarted += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await oldGate.promise;
        active -= 1;
        return `old-${index}`;
      }),
    );
    await Promise.resolve();
    expect(oldStarted).toBe(2);

    const newGeneration = coordinator.beginGeneration();
    const newRequests = Array.from({ length: 8 }, (_, index) =>
      coordinator.request(newGeneration, `new-${index}`, async () => {
        newStarted += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return `new-${index}`;
      }),
    );
    oldGate.resolve();

    const [oldResults, newResults] = await Promise.all([Promise.all(oldRequests), Promise.all(newRequests)]);
    expect(oldStarted).toBe(2);
    expect(newStarted).toBe(8);
    expect(maxActive).toBe(2);
    expect(oldResults).toEqual(Array(8).fill(undefined));
    expect(newResults).toEqual(Array.from({ length: 8 }, (_, index) => `new-${index}`));
    coordinator.dispose();
  });
});
