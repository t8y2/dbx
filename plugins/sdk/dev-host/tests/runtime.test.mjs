import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startDevelopment, resolveGoWorkVersion } from "../runtime.mjs";
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

test("go.work go directive tracks the newest module requirement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dbx-dev-gowork-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "newer"), { recursive: true });
  await mkdir(join(root, "older"), { recursive: true });
  await writeFile(join(root, "newer/go.mod"), "module example.com/newer\n\ngo 1.25.0\n");
  await writeFile(join(root, "older/go.mod"), "module example.com/older\n\ngo 1.21\n");
  assert.equal(await resolveGoWorkVersion([join(root, "newer"), join(root, "older")]), "1.25.0");
  // No readable go.mod: fall back to the historical base version.
  assert.equal(await resolveGoWorkVersion([join(root, "missing")]), "1.22");
});

test("backend build go.work is written with the module go directive", async (t) => {
  const options = await project(t);
  const moduleDirectory = join(options.project, "go-sdk");
  await mkdir(moduleDirectory, { recursive: true });
  await writeFile(join(moduleDirectory, "go.mod"), "module example.com/go-sdk\n\ngo 1.25.0\n");
  const host = await startDevelopment({
    ...options,
    commands: { backend: { command: process.execPath, args: ["-e", "process.exit(0)"], goWorkspace: [moduleDirectory] } },
  });
  t.after(() => host.close());
  const work = await readFile(join(options.project, ".dbx-dev", "go.work"), "utf8");
  assert.match(work, /^go 1\.25\.0$/m);
  assert.ok(work.includes(JSON.stringify(moduleDirectory)), "workspace lists the SDK module");
});

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
  let host;
  t.after(() => host?.close());
  const options = await project(t),
    pidFile = join(options.project, "watcher.pid");
  host = await startDevelopment({ ...options, commands: { watch: [process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidFile] } });
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
  let host;
  t.after(() => host?.close());
  const options = await project(t);
  host = await startDevelopment({ ...options, commands: { watch: [process.execPath, "-e", 'process.stdout.write("x".repeat(1100)+"DBX_UI_BUILD_SUCCESS\\n"); process.stdout.write("DBX_UI_BUILD_"); setTimeout(() => process.stdout.write("SUCCESS\\n"), 100); setInterval(() => {}, 1000)'] } });
  let revision = 0;
  for (let i = 0; i < 100 && !revision; i++) {
    await delay(20);
    revision = (await (await fetch(`${host.origin}/api/bootstrap`)).json()).revision;
  }
  assert.equal(revision, 1);
});
