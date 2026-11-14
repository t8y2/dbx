import { bench, describe } from "vitest";
import { writeFileSync } from "node:fs";
import { mysql, postgresql, sqlite } from "sql-formatter";
import { DataGripFormatBudgetError, formatDataGripSql } from "../../apps/desktop/src/lib/sql/datagrip/format";
import { DEFAULT_SQL_FORMATTER_SETTINGS } from "../../apps/desktop/src/lib/sql/sqlFormatterConfig";
import type { DataGripDialect } from "../../apps/desktop/src/lib/sql/datagrip/types";
import { cancelDataGripFormatterOwner, disposeDataGripFormatterWorker, formatDataGripSqlUsingWorker } from "../../apps/desktop/src/lib/sql/sqlFormatterWorker";

const dialectOptions = { postgres: postgresql, mysql, sqlite };
const settings = { ...DEFAULT_SQL_FORMATTER_SETTINGS, keywordCase: "preserve" as const, tabWidth: 4 as const };
const longList = `select ${Array.from({ length: 160 }, (_, index) => `column_${index}`).join(",")} from users;`;
const deepNested = `select ${"(select ".repeat(30)}1${")".repeat(30)};`;
const multiStatement = Array.from({ length: 200 }, (_, index) => `select id_${index} from table_${index} where active=true and id=${index};`).join("\n");
const millionCharacters = "select id,name,email from users where active=true;\n".repeat(Math.floor(1_000_000 / 48));
const cases = [
  { name: "typical", dialect: "postgres", sql: "select u.id,u.name,o.total from users u left join orders o on o.user_id=u.id where u.active=true and o.total>10 order by o.total desc;" },
  { name: "long-select-list", dialect: "mysql", sql: longList },
  { name: "deep-nesting", dialect: "postgres", sql: deepNested },
  { name: "multi-statement", dialect: "sqlite", sql: multiStatement },
  { name: "million-characters", dialect: "postgres", sql: millionCharacters },
] as const;

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue))] ?? 0;
}

async function measure(item: (typeof cases)[number]) {
  const durations: number[] = [];
  const heapBefore = process.memoryUsage().heapUsed;
  let heapPeak = heapBefore;
  let astNodes = 0;
  let blockNodes = 0;
  let budgetRejected = false;
  for (let iteration = 0; iteration < 14; iteration++) {
    try {
      const started = performance.now();
      const result = await formatDataGripSql({ sql: item.sql, dialect: item.dialect, dialectOptions: dialectOptions[item.dialect], settings, paramTypes: null });
      durations.push(performance.now() - started);
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      astNodes = result.metrics.astNodes;
      blockNodes = result.metrics.blockNodes;
    } catch (error) {
      if (!(error instanceof DataGripFormatBudgetError)) throw error;
      budgetRejected = true;
    }
  }
  return {
    name: item.name,
    dialect: item.dialect,
    characters: item.sql.length,
    iterations: durations.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length ? Math.max(...durations) : 0,
    heapGrowthBytes: Math.max(0, heapPeak - heapBefore),
    budgetRejected,
    astNodes,
    blockNodes,
  };
}

class BenchmarkWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  postMessage(): void {}
  terminate(): void {}
}

async function measureCancellation(): Promise<number> {
  const originalWorker = globalThis.Worker;
  try {
    globalThis.Worker = BenchmarkWorker as unknown as typeof Worker;
    const pending = formatDataGripSqlUsingWorker("select 1", "postgres", DEFAULT_SQL_FORMATTER_SETTINGS, "benchmark");
    const started = performance.now();
    cancelDataGripFormatterOwner("benchmark");
    await pending;
    return performance.now() - started;
  } finally {
    disposeDataGripFormatterWorker();
    globalThis.Worker = originalWorker;
  }
}

const cancellationMs = await measureCancellation();
const measurements = [];
for (const item of cases) measurements.push(await measure(item));
const output = process.env.DATAGRIP_BENCHMARK_OUTPUT;
if (output) writeFileSync(output, JSON.stringify({ node: process.version, measurements, mainThreadEngineWork: "not-run-by-design", cancellationMs }, null, 2) + "\n");

describe("DataGrip formatter", () => {
  for (const item of cases) {
    bench(
      `${item.name} (${item.dialect})`,
      async () => {
        try {
          await formatDataGripSql({ sql: item.sql, dialect: item.dialect as DataGripDialect, dialectOptions: dialectOptions[item.dialect], settings, paramTypes: null });
        } catch (error) {
          if (!(error instanceof DataGripFormatBudgetError)) throw error;
        }
      },
      { iterations: 10, warmupIterations: 2 },
    );
  }
});
