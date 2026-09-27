import { appendFile } from "node:fs/promises";

const CONSOLE_LIMIT = 20;

export function collectFileTimings(testModules) {
  return testModules
    .map((testModule) => {
      const diagnostic = testModule.diagnostic();
      const setupMs = diagnostic.environmentSetupDuration + diagnostic.prepareDuration + diagnostic.setupDuration;
      return {
        file: testModule.relativeModuleId,
        state: testModule.state(),
        totalMs: setupMs + diagnostic.collectDuration + diagnostic.duration,
        testsMs: diagnostic.duration,
        collectMs: diagnostic.collectDuration,
        setupMs,
      };
    })
    .sort((left, right) => right.totalMs - left.totalMs || left.file.localeCompare(right.file));
}

function seconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}

export function consoleReport(rows, limit = CONSOLE_LIMIT) {
  const lines = ["Slowest test files:"];
  for (const row of rows.slice(0, limit)) {
    lines.push(`${seconds(row.totalMs).padStart(8)}  ${row.file}`);
  }
  return lines.join("\n");
}

function tableCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function markdownReport(rows, shard = "") {
  const title = shard ? `## Vitest file timings (${tableCell(shard)})` : "## Vitest file timings";
  const lines = [title, "", "| Total | Tests | Collect | Setup | State | File |", "| ---: | ---: | ---: | ---: | --- | --- |"];
  for (const row of rows) {
    lines.push(`| ${seconds(row.totalMs)} | ${seconds(row.testsMs)} | ${seconds(row.collectMs)} | ${seconds(row.setupMs)} | ${row.state} | \`${tableCell(row.file)}\` |`);
  }
  return `${lines.join("\n")}\n`;
}

export default class FileTimingReporter {
  async onTestRunEnd(testModules) {
    const rows = collectFileTimings(testModules);
    console.log(`\n${consoleReport(rows)}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdownReport(rows, process.env.VITEST_SHARD), "utf8");
    }
  }
}
