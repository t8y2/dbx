import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { delimiter, join } from "node:path";

const tasks = [
  {
    name: "format",
    command: "oxfmt",
    args: ["--check", "apps/desktop/src/**/*.{ts,vue}"],
  },
  {
    name: "lint",
    command: "oxlint",
    args: ["--vue-plugin", "apps/desktop/src"],
  },
  {
    name: "typecheck",
    command: "vue-tsc",
    args: ["--noEmit", "--project", "apps/desktop/tsconfig.json"],
  },
  {
    name: "test",
    command: "vitest",
    args: ["run"],
  },
];

function runTask(task) {
  const startedAt = performance.now();
  const command = commandSpec(task);
  const child = spawn(command.program, command.args, {
    cwd: process.cwd(),
    env: commandEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];

  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  return new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({
        ...task,
        code: 1,
        durationMs: performance.now() - startedAt,
        output: "",
        errorOutput: error.stack ?? String(error),
      });
    });

    child.on("close", (code) => {
      resolve({
        ...task,
        code,
        durationMs: performance.now() - startedAt,
        output: Buffer.concat(stdout).toString(),
        errorOutput: Buffer.concat(stderr).toString(),
      });
    });
  });
}

function commandSpec(task) {
  if (process.platform !== "win32") return { program: task.command, args: task.args };
  const command = join(process.cwd(), "node_modules", ".bin", `${task.command}.CMD`);
  return { program: "cmd.exe", args: ["/d", "/c", "call", command, ...task.args] };
}

function commandEnv() {
  return {
    ...process.env,
    PATH: [join(process.cwd(), "node_modules", ".bin"), process.env.PATH].filter(Boolean).join(delimiter),
  };
}

function outputFailureExcerpt(output) {
  const lines = output.trimEnd().split(/\r?\n/);
  const selected = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    if (!/\bnot ok\b|AssertionError|ERR_ASSERT|^# fail\b|^# tests\b|^# pass\b/.test(lines[index])) continue;
    const start = Math.max(0, index - 2);
    const end = Math.min(lines.length, index + 14);
    for (let lineIndex = start; lineIndex < end; lineIndex += 1) {
      selected.add(lineIndex);
    }
  }

  if (selected.size === 0) return "";

  const excerpt = [];
  let previous = -2;
  for (const index of [...selected].sort((a, b) => a - b)) {
    if (index > previous + 1 && excerpt.length > 0) excerpt.push("...");
    excerpt.push(lines[index]);
    previous = index;
  }
  return excerpt.join("\n");
}

function tailOutput(output, maxLines = 120) {
  const lines = output.trimEnd().split(/\r?\n/);
  if (lines.length <= maxLines) return lines.join("\n");
  return [`... omitted ${lines.length - maxLines} earlier line(s) ...`, ...lines.slice(-maxLines)].join("\n");
}

const results = await Promise.all(tasks.map(runTask));

for (const result of results) {
  const seconds = (result.durationMs / 1000).toFixed(2);
  const status = result.code === 0 ? "ok" : "failed";
  console.log(`${status.padEnd(6)} ${result.name.padEnd(9)} ${seconds}s`);
}

const failures = results.filter((result) => result.code !== 0);

for (const failure of failures) {
  console.error(`\n${failure.name} output:`);
  if (failure.output) {
    const excerpt = outputFailureExcerpt(failure.output);
    if (excerpt) {
      console.error("failure excerpt:");
      console.error(excerpt);
      console.error("\noutput tail:");
    }
    console.error(tailOutput(failure.output));
  }
  if (failure.errorOutput) {
    console.error(tailOutput(failure.errorOutput));
  }
}

if (failures.length > 0) {
  process.exit(1);
}
