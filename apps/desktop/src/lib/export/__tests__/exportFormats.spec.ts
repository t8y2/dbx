import { describe, expect, it } from "vitest";
import { formatCsv, formatTsv } from "@/lib/export/exportFormats";

describe("formatCsv NULL handling", () => {
  it("writes NULL as an unquoted marker and an empty string as an empty quoted field", () => {
    // 即使 quote mode = all，NULL 字面量也必须裸写：PostgreSQL/ClickHouse 的 CSV 读取
    // 不把带引号的 `"\N"` 当作 NULL，裸 `\N` 才是它们和 MySQL 共同识别的写法。
    expect(
      formatCsv(
        ["id", "name"],
        [
          [1, ""],
          [2, null],
        ],
        "all",
        "\\N",
      ),
    ).toBe('"id","name"\n"1",""\n"2",\\N');
  });

  it("keeps the marker unquoted when only necessary fields are quoted", () => {
    expect(
      formatCsv(
        ["id", "name"],
        [
          [1, ""],
          [2, null],
        ],
        "necessary",
        "\\N",
      ),
    ).toBe("id,name\n1,\n2,\\N");
  });

  it("quotes a marker that itself needs quoting", () => {
    // 自定义字面量含分隔符时无法裸写，只能退化成带引号的普通字段
    expect(formatCsv(["id", "name"], [[1, null]], "all", "a,b")).toBe('"id","name"\n"1","a,b"');
  });

  it("restores the legacy empty field when the marker is disabled", () => {
    // 关闭字面量时 NULL 是完全空字段、空字符串是 `""`：CSV 引号语义上仍有区别，
    // 但 DBX 的导入端比较的是去引号后的值，因此旧格式在往返时依赖不了这个区别。
    expect(
      formatCsv(
        ["id", "name"],
        [
          [1, ""],
          [2, null],
        ],
        "all",
        "",
      ),
    ).toBe('"id","name"\n"1",""\n"2",');
  });
});

describe("formatTsv", () => {
  it("copies a value that only contains double quotes verbatim (#10087)", () => {
    const output = formatTsv(["id", "mag"], [[1, '"9932b4d2ad1c4ff88b5bfe1690ee1bb8"']]);

    expect(output).toBe('id\tmag\n1\t"9932b4d2ad1c4ff88b5bfe1690ee1bb8"');
  });

  it("still quotes values containing a tab or newline so the TSV shape survives", () => {
    const output = formatTsv(["v"], [["a\tb"], ["c\nd"]]);

    expect(output).toBe('v\n"a\tb"\n"c\nd"');
  });

  it("renders NULL as an empty field without adding quotes", () => {
    const output = formatTsv(["id", "name"], [[1, null]]);

    expect(output).toBe("id\tname\n1\t");
  });
});
