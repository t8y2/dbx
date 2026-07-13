const EXCEL_CELL_CHARACTER_LIMIT = 32_767;

export interface XlsxSqlStatement {
  resultName?: string;
  sql: string;
}

export interface XlsxSqlWorksheet {
  sheetName: "SQL";
  columns: string[];
  rows: Array<Array<string>>;
}

function splitExcelCellText(value: string): string[] {
  if (value.length <= EXCEL_CELL_CHARACTER_LIMIT) return [value];

  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + EXCEL_CELL_CHARACTER_LIMIT, value.length);
    if (end < value.length) {
      const lastCodeUnit = value.charCodeAt(end - 1);
      const nextCodeUnit = value.charCodeAt(end);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        end -= 1;
      }
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

export function buildXlsxSqlWorksheet(statements: readonly XlsxSqlStatement[]): XlsxSqlWorksheet | undefined {
  const available = statements.filter((statement) => statement.sql.trim().length > 0);
  if (available.length === 0) return undefined;

  if (available.length === 1) {
    return {
      sheetName: "SQL",
      columns: ["SQL"],
      rows: splitExcelCellText(available[0].sql).map((sql) => [sql]),
    };
  }

  return {
    sheetName: "SQL",
    columns: ["Result", "SQL"],
    rows: available.flatMap((statement, index) => splitExcelCellText(statement.sql).map((sql) => [statement.resultName || `Result ${index + 1}`, sql])),
  };
}
