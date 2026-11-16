import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const indexHtml = readFileSync(fileURLToPath(new URL("../../../../index.html", import.meta.url)), "utf8");
const floatingFrameScript = [...indexHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((script) => script.includes("window.__DBX_LINUX_FLOATING__"));

if (!floatingFrameScript) throw new Error("Linux floating frame script not found");

describe("startup Linux floating frame", () => {
  it.each([undefined, false])("keeps opaque windows opaque when the native floating frame flag is %s", (flag) => {
    const addClass = vi.fn();

    Function("document", "window", floatingFrameScript)({ documentElement: { classList: { add: addClass } } }, { __DBX_LINUX_FLOATING__: flag });

    expect(addClass).not.toHaveBeenCalled();
  });

  it("draws the floating frame when the native window explicitly opts into transparency", () => {
    const addClass = vi.fn();

    Function("document", "window", floatingFrameScript)({ documentElement: { classList: { add: addClass } } }, { __DBX_LINUX_FLOATING__: true });

    expect(addClass).toHaveBeenCalledOnce();
    expect(addClass).toHaveBeenCalledWith("dbx-linux-floating");
  });
});
