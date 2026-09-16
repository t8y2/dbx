import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

// Unix children must be spawned detached so their process group belongs to us.
export async function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", resolve);
      killer.once("close", resolve);
    });
    return;
  }
  const signal = (value) => {
    try {
      process.kill(-child.pid, value);
      return true;
    } catch (error) {
      // macOS can return EPERM for a group containing only reparented zombies.
      if (error.code === "ESRCH" || (value === 0 && error.code === "EPERM")) return false;
      throw error;
    }
  };
  if (!signal("SIGTERM")) return;
  // A leader exiting does not imply that its descendants have exited.
  for (let i = 0; i < 40; i++) {
    await delay(50);
    if (!signal(0)) return;
  }
  signal("SIGKILL");
}
