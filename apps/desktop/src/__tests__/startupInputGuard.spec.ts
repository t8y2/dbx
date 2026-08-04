// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync(resolve(process.cwd(), "apps/desktop/index.html"), "utf8");
const mainSource = readFileSync(resolve(process.cwd(), "apps/desktop/src/main.ts"), "utf8");

function installStartupInputGuard() {
  const script = indexSource.match(/<script data-dbx-startup-input-guard>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Startup input guard script not found");
  new Function(script)();
}

describe("startup input guard", () => {
  it("prevents Escape until the app is mounted", () => {
    installStartupInputGuard();

    const startupEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    const regularKey = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    window.dispatchEvent(startupEscape);
    window.dispatchEvent(regularKey);

    expect(startupEscape.defaultPrevented).toBe(true);
    expect(regularKey.defaultPrevented).toBe(false);

    window.dispatchEvent(new Event("dbx:startup-ready"));
    const readyEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(readyEscape);
    expect(readyEscape.defaultPrevented).toBe(false);
  });

  it("installs before the application module and is released after mount", () => {
    expect(indexSource.indexOf("data-dbx-startup-input-guard")).toBeLessThan(indexSource.indexOf('src="/src/main.ts"'));
    expect(mainSource.indexOf('app.mount("#root")')).toBeLessThan(mainSource.indexOf('window.dispatchEvent(new Event("dbx:startup-ready"))'));
  });
});
