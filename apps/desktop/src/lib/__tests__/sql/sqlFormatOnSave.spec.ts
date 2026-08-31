import { describe, expect, it } from "vitest";
import { formatSqlSnapshotForSave } from "@/lib/sql/sqlFormatOnSave";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("formatSqlSnapshotForSave", () => {
  it("does not overwrite edits made while formatting loads", async () => {
    const formatting = deferred<string>();
    let sql = "select 1";
    const pending = formatSqlSnapshotForSave(
      sql,
      () => sql,
      () => formatting.promise,
      (formatted) => {
        sql = formatted;
      },
    );

    sql = "select 2";
    formatting.resolve("SELECT 1");

    await expect(pending).resolves.toBe("select 2");
    expect(sql).toBe("select 2");
  });

  it("applies and returns formatted SQL when the snapshot is unchanged", async () => {
    let sql = "select 1";
    await expect(
      formatSqlSnapshotForSave(
        sql,
        () => sql,
        async () => "SELECT 1",
        (formatted) => {
          sql = formatted;
        },
      ),
    ).resolves.toBe("SELECT 1");
    expect(sql).toBe("SELECT 1");
  });
});
