import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function changeBase({ eventName, before, root = process.cwd() }) {
  if (eventName === "pull_request") {
    const commits = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
      cwd: root, encoding: "utf8", stdio: "pipe",
    }).trim().split(/\s+/);
    if (commits.length !== 3) throw new Error("PR change detection requires the checked-out merge commit and both parents");
    return commits[1];
  }
  if (!before || /^0+$/.test(before)) return null;
  if (!/^[0-9a-f]{40}$/.test(before)) throw new Error("Invalid push base SHA");
  return before;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const base = changeBase({ eventName: process.env.GITHUB_EVENT_NAME, before: process.env.BEFORE_SHA });
  if (base) console.log(base);
}
