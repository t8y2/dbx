export interface StatementDelimiterDocument {
  readonly length: number;
  sliceString(from: number, to: number): string;
}

type StatementDelimiterSource = string | StatementDelimiterDocument;

export function trailingStatementDelimiterPosition(source: StatementDelimiterSource, rangeTo: number): number | null {
  let delimiterPos = rangeTo;
  let lineBreakCount = 0;
  while (delimiterPos < source.length) {
    const char = sliceSource(source, delimiterPos, delimiterPos + 1);
    if (!/\s/u.test(char)) break;
    if (char === "\n" && ++lineBreakCount > 1) return null;
    delimiterPos += 1;
  }
  return sliceSource(source, delimiterPos, delimiterPos + 1) === ";" ? delimiterPos : null;
}

export function cursorBelongsToTrailingStatementDelimiter(source: StatementDelimiterSource, rangeTo: number, cursorPos: number): boolean {
  if (cursorPos < rangeTo) return false;
  const delimiterPos = trailingStatementDelimiterPosition(source, rangeTo);
  if (delimiterPos === null) return false;
  if (cursorPos <= delimiterPos + 1) return true;

  const afterDelimiter = sliceSource(source, delimiterPos + 1, cursorPos);
  // 分号到光标之间允许是空白或尾部注释（如 `SELECT 1; -- 备注`），
  // 块注释自身可以跨行，但注释之外的换行仍表示光标已进入下一行
  // 否则行尾注释后的光标会被下一条语句的前置区域错误认领
  return trailingGapIsWhitespaceOrComment(afterDelimiter);
}

/**
 * 判断语句分号与光标之间的间隙是否只包含空白和注释。
 * 块注释内部允许换行；注释之外的换行表示光标已离开分号所在行。
 */
function trailingGapIsWhitespaceOrComment(gap: string): boolean {
  let i = 0;
  while (i < gap.length) {
    const ch = gap[i] ?? "";
    const next = gap[i + 1] ?? "";

    // 普通空白直接跳过
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "\n") return false;

    // 行注释：`--`（SQL 标准）或 `//`（MongoDB shell），其后内容直到行尾都是注释
    if ((ch === "-" && next === "-") || (ch === "/" && next === "/")) return true;

    // `#` 行注释（MySQL 等），但 `#{` 是 MyBatis 参数语法，不是注释
    if (ch === "#" && next !== "{") return true;

    // 块注释 /* ... */：跳过整段后继续检查剩余间隙
    if (ch === "/" && next === "*") {
      const close = gap.indexOf("*/", i + 2);
      // 未闭合的块注释：剩余部分全部视为注释
      if (close === -1) return true;
      i = close + 2;
      continue;
    }

    // 出现其他实际内容，说明光标后面还有语句文本，不能归属上一条语句
    return false;
  }
  return true;
}

function sliceSource(source: StatementDelimiterSource, from: number, to: number): string {
  return typeof source === "string" ? source.slice(from, to) : source.sliceString(from, to);
}
