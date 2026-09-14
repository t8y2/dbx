import { spawn } from "node:child_process";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createMockHost } from "./server.mjs";
import { Diagnostics } from "./diagnostics.mjs";
import { stopProcessTree } from "./process-tree.mjs";

export async function startDevelopment(options) {
  const diagnostics = options.diagnostics || new Diagnostics();
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("dbx-plugin dev requires Node.js 22+");
  const project = resolve(options.project),
    dataDir = resolve(options.dataDir || resolve(project, ".dbx-dev"));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  await mkdir(resolve(dataDir, "bin"), { recursive: true });
  const children = new Set();
  let host,
    stopping = false;
  async function spawnCommand(spec, watch = false) {
    if (stopping) throw new Error("Development host is stopping");
    if (Array.isArray(spec)) spec = { command: spec[0], args: spec.slice(1), cwd: project };
    if (!spec?.command || !Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string")) throw new Error("Invalid build command");
    const env = { ...process.env };
    if (spec.goWorkspace) {
      const work = resolve(dataDir, "go.work");
      await writeFile(work, `go 1.22\n\nuse (\n${spec.goWorkspace.map((p) => "\t" + JSON.stringify(p)).join("\n")}\n)\n`, { mode: 0o600 });
      env.GOWORK = work;
    }
    let command = spec.command === "node" ? process.execPath : spec.command;
    let args = spec.args;
    // Windows npm launchers are batch files; invoke npm's JS entrypoint through Node.
    if (process.platform === "win32" && command === "npm") {
      const npm = process.env.npm_execpath || resolve(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
      command = process.execPath;
      args = [npm, ...args];
    }
    if (stopping) throw new Error("Development host is stopping");
    const child = spawn(command, args, { cwd: spec.cwd || project, env, stdio: ["ignore", watch ? "pipe" : "inherit", "inherit"], detached: process.platform !== "win32" });
    children.add(child);
    child.once("exit", () => {
      child.cleanup = stopProcessTree(child);
      child.cleanup.then(
        () => children.delete(child),
        () => {},
      );
    });
    return child;
  }
  async function run(spec) {
    diagnostics.record("info", "build", "构建命令开始");
    const child = await spawnCommand(spec);
    await new Promise((accept, reject) => {
      child.once("error", () => reject(new Error("Cannot start build command")));
      child.once("exit", (code) => (code === 0 ? accept() : reject(new Error(`Build failed (exit ${code})`))));
    }).catch((error) => {
      diagnostics.record("error", "build", "构建命令失败");
      throw error;
    });
    diagnostics.record("info", "build", "构建命令完成");
    if (stopping) throw new Error("Development host is stopping");
  }
  async function stopChildren() {
    await Promise.all([...children].map((child) => child.cleanup || stopProcessTree(child)));
  }
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stopChildren();
    await host?.close();
  };
  const onSignal = () => void stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const commands = options.commands || {};
    if (commands.backend) await run(commands.backend);
    if (commands.ui?.length) await run(commands.ui);
    if (stopping) throw new Error("Development host is stopping");
    host = await createMockHost({
      ...options,
      project,
      dataDir,
      diagnostics,
      uiBuildSignals: Boolean(commands.watch?.length),
      shellHtml: options.shellHtml || resolve(dirname(fileURLToPath(import.meta.url)), "ui/index.html"),
      buildBackend: commands.backend ? () => run(commands.backend) : undefined,
    });
    if (stopping) {
      await host.close();
      throw new Error("Development host is stopping");
    }
    if (commands.watch?.length) {
      const watcher = await spawnCommand(commands.watch, true);
      let line = "",
        oversized = false;
      watcher.stdout.setEncoding("utf8");
      watcher.stdout.on("data", (chunk) => {
        process.stdout.write(chunk);
        for (const character of chunk) {
          if (character === "\n") {
            if (!oversized && line.replace(/\r$/, "") === "DBX_UI_BUILD_SUCCESS") {
              void host.uiBuilt().catch(() => diagnostics.record("error", "build", "前端构建产物不可读取"));
            }
            line = "";
            oversized = false;
          } else if (line.length < 1024) line += character;
          else oversized = true;
        }
      });
      watcher.on("error", () => diagnostics.record("error", "build", "前端构建监听启动失败"));
      watcher.on("exit", (code) => {
        if (!stopping) diagnostics.record("error", "build", "前端构建监听已退出", { exitCode: code });
      });
    }
    console.log(`Plugin dev host: ${host.origin}`);
    console.log("Development credentials are stored locally as plaintext in the configured data directory.");
    return { ...host, close: stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== "--config" || !process.argv[3]) throw new Error("Start this runtime using dbx-plugin dev");
    await startDevelopment(JSON.parse(process.argv[3]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
