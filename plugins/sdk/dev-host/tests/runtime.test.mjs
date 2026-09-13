import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDevelopment } from "../runtime.mjs";
import { Diagnostics } from "../diagnostics.mjs";

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "dbx-dev-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "ui"));
  await writeFile(join(root, "ui/index.html"), "<html><head></head><body>Test</body></html>");
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      manifest_version: 1,
      id: "example.frontend",
      version: "1.0.0",
      name: "Example",
      entrypoints: { ui: { root: "ui", entry: "ui/index.html" } },
      contributions: [],
      permissions: [],
    }),
  );
  return { project: root, port: 0, shellHtml: join(root, "ui/index.html"), diagnostics: new Diagnostics(() => {}) };
}

test("failed build does not start a host or retain signal listeners", async (t) => {
  const options = await project(t);
  const before = process.listenerCount("SIGTERM");
  await assert.rejects(
    startDevelopment({
      ...options,
      commands: {
        backend: {
          command: process.execPath,
          args: ["-e", "process.exit(7)"],
        },
      },
    }),
    /Build failed/,
  );
  assert.equal(process.listenerCount("SIGTERM"), before);
});

test("development credentials cannot be placed inside UI resources", async (t) => {
  const options = await project(t);
  await assert.rejects(startDevelopment({ ...options, dataDir: join(options.project, "ui", "private") }), /outside the UI/);
});

test("closing development host terminates its UI watcher and releases its port", async (t) => {
  const options = await project(t),
    pidFile = join(options.project, "watcher.pid");
  const host = await startDevelopment({ ...options, commands: { watch: [process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidFile] } });
  t.after(() => host.close());
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      pid = Number(await readFile(pidFile, "utf8"));
      break;
    } catch {
      await delay(20);
    }
  }
  assert.ok(pid, "watcher started");
  await host.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await assert.rejects(fetch(host.origin));
});

test("watcher success markers trigger reload only after a complete line", async (t) => {
  const options = await project(t);
  const host = await startDevelopment({ ...options, commands: { watch: [process.execPath, "-e", 'process.stdout.write("x".repeat(1100)+"DBX_UI_BUILD_SUCCESS\\n"); process.stdout.write("DBX_UI_BUILD_"); setTimeout(() => process.stdout.write("SUCCESS\\n"), 100); setInterval(() => {}, 1000)'] } });
  t.after(() => host.close());
  let revision = 0;
  for (let i = 0; i < 100 && !revision; i++) {
    await delay(20);
    revision = (await (await fetch(`${host.origin}/api/bootstrap`)).json()).revision;
  }
  assert.equal(revision, 1);
});
