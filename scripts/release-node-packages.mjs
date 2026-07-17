import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const releaseScript = fileURLToPath(new URL("./release.mjs", import.meta.url));
const result = spawnSync(process.execPath, [releaseScript, "packages", ...process.argv.slice(2)], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
