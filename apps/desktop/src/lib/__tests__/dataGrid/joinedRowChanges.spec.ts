import { describe, expect, it } from "vitest";
import { joinedRowChanges, type JoinedWriteSource } from "../../dataGrid/joinedRowChanges";

const sources: JoinedWriteSource[] = [
  { tableKey: "users", primaryKeys: ["id"], sourceColumns: ["id", "name", undefined, undefined] },
  { tableKey: "papers", primaryKeys: ["id"], sourceColumns: [undefined, undefined, "id", "title"] },
];

describe("joined row updates", () => {
  it("routes edits on both tables to their own primary key row", () => {
    const updates = joinedRowChanges(
      sources,
      [[1, "user", 20, "paper"]],
      new Map([
        [
          0,
          new Map([
            [1, "renamed"],
            [3, "retitled"],
          ]),
        ],
      ]),
    );
    expect(updates).toEqual([
      { sourceIndex: 0, rowIndex: 0, changes: new Map([[1, "renamed"]]) },
      { sourceIndex: 1, rowIndex: 0, changes: new Map([[3, "retitled"]]) },
    ]);
  });

  it("coalesces the same user repeated by a one-to-many join", () => {
    const rows = [
      [1, "user", 20, "one"],
      [1, "user", 21, "two"],
    ];
    const updates = joinedRowChanges(
      sources,
      rows,
      new Map([
        [0, new Map([[1, "same"]])],
        [1, new Map([[1, "same"]])],
      ]),
    );
    expect(updates).toHaveLength(1);
    expect(() =>
      joinedRowChanges(
        sources,
        rows,
        new Map([
          [0, new Map([[1, "first"]])],
          [1, new Map([[1, "second"]])],
        ]),
      ),
    ).toThrow("Conflicting edits");
  });

  it("rejects an outer join row without an existing target record", () => {
    expect(() => joinedRowChanges(sources, [[1, "user", null, null]], new Map([[0, new Map([[3, "new"]])]]))).toThrow("unmatched outer-join");
  });

  it("never treats an unbound expression or incomplete key as writable", () => {
    expect(() => joinedRowChanges(sources, [[1, "user", 20, "paper", 5]], new Map([[0, new Map([[4, "value"]])]]))).toThrow("unique source");
    expect(() => joinedRowChanges([{ ...sources[0]!, primaryKeys: ["missing"] }], [[1, "user"]], new Map([[0, new Map([[1, "new"]])]]))).toThrow("complete primary key");
  });

  it("distinguishes composite keys and physical tables", () => {
    const composite = [{ tableKey: "users", primaryKeys: ["tenant", "id"], sourceColumns: ["tenant", "id", "name"] }];
    expect(
      joinedRowChanges(
        composite,
        [
          [1, 2, "a"],
          [2, 2, "b"],
        ],
        new Map([
          [0, new Map([[2, "x"]])],
          [1, new Map([[2, "y"]])],
        ]),
      ),
    ).toHaveLength(2);
  });
});
