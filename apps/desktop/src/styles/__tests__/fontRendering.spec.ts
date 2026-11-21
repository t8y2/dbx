import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

describe("global font rendering", () => {
  it("leaves font smoothing to the operating system by default", () => {
    // The base body rule must stay smoothing-free; the opt-in lives behind
    // html.dbx-font-smoothing so the default rendering is unchanged (#13359).
    const bodyRule = globalsCss.match(/\n  body \{[^}]*\}/)?.[0] ?? "";
    expect(bodyRule).not.toContain("-webkit-font-smoothing");
    expect(bodyRule).not.toContain("-moz-osx-font-smoothing");
  });

  it("restores macOS-style smoothing only under the opt-in class", () => {
    const optIn = globalsCss.match(/html\.dbx-font-smoothing body \{[^}]*\}/)?.[0] ?? "";
    expect(optIn).toContain("-webkit-font-smoothing: antialiased");
    expect(optIn).toContain("-moz-osx-font-smoothing: grayscale");
  });
});
