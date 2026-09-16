// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mounting is `main.ts`'s module-level side effect, so importing it IS the
// test. The module cache would return the first import's result for the
// second, running nothing — hence resetModules between cases.
beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `<div id="app"></div>`;
});

describe("the export entry point", () => {
  it("says so when the document carries no payload at all", async () => {
    await import("../main");
    expect(document.querySelector("#app")?.textContent).toContain("could not be read");
    expect(document.querySelector("#app")?.textContent).toContain("application/dbx-snapshot");
  });

  it("says so when the payload is present but not decodable", async () => {
    // A truncated file, or one an editor has line-wrapped and mangled. This
    // failure arrives as a DOMException from `atob` rather than the Error
    // thrown above, so it is a genuinely different path through the catch —
    // and the reader must still get a sentence instead of a white screen.
    const node = document.createElement("script");
    node.type = "application/dbx-snapshot";
    node.textContent = "not base64 at all!";
    document.body.appendChild(node);

    await import("../main");
    const rendered = document.querySelector("#app")?.textContent ?? "";
    expect(rendered).toContain("could not be read");
    // Deliberately not asserting the decoder's own wording: Chrome, Firefox and
    // Safari each phrase the atob failure differently, and pinning one of them
    // would make this test a statement about the runtime rather than about the
    // export. What must hold is that the message is ours and is not the
    // missing-element one.
    expect(rendered).not.toContain("no <script");
    expect(rendered.length).toBeGreaterThan("This documentation file could not be read: ".length);
  });
});
