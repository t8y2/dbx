import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tauriArgs = process.argv.slice(2);

if (tauriArgs.length === 0) {
  console.error("Usage: node scripts/tauri-windows.mjs <tauri-subcommand> [...args]");
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    cwd: root,
    ...options,
  });
  process.exit(result.status ?? 1);
}

if (platform() === "win32") {
  const envScript = join(root, "scripts", "windows-build-env.ps1");
  const tauriCmd = ["pnpm", "tauri", ...tauriArgs]
    .map((arg) => arg.replace(/'/g, "''"))
    .join(" ");
  run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `. '${envScript.replace(/'/g, "''")}'; ${tauriCmd}`,
    ],
    { shell: false },
  );
} else {
  run("pnpm", ["tauri", ...tauriArgs], { shell: true });
}
