// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { readPayload } from "../exportPayload";

/** Write the document Task 6's Rust side emits: base64 of UTF-8 JSON. */
function embed(payload: unknown): void {
  document.body.innerHTML = `<div id="app"></div>`;
  const node = document.createElement("script");
  node.type = "application/dbx-snapshot";
  node.textContent = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  document.body.appendChild(node);
}

const snapshot = { formatVersion: 1, project: { name: "顧客データベース", databaseType: "postgres" }, tables: [{ schema: "public", name: "顧客", columns: [{ name: "名前", note: "Café — naïve ★" }] }] };

afterEach(() => {
  document.body.innerHTML = "";
});

describe("readPayload", () => {
  it("round-trips non-ASCII through base64", () => {
    // The regression this exists to catch: `JSON.parse(atob(text))` mounts and
    // renders, so every test downstream of it passes — while a Japanese table
    // name arrives as mojibake in a file someone opens offline with no way to
    // report it. atob yields one byte per character; the payload is UTF-8.
    embed({ snapshot, annotations: { formatVersion: 1 }, lang: "ja" });
    const payload = readPayload();
    expect(payload.snapshot.project.name).toBe("顧客データベース");
    expect(payload.snapshot.tables[0].name).toBe("顧客");
    expect(payload.snapshot.tables[0].columns[0].note).toBe("Café — naïve ★");
    expect(payload.lang).toBe("ja");
  });

  it("carries the annotations layer through unchanged", () => {
    // Task 6 must emit this key even when empty — DocsApp reads
    // `annotations.groups` and a missing object throws before anything renders.
    embed({ snapshot, annotations: { formatVersion: 1, groups: [{ id: "a", name: "Grupo", hue: 210 }] }, lang: "pt-BR" });
    expect(readPayload().annotations.groups?.[0].name).toBe("Grupo");
  });

  it("names the missing element rather than throwing something opaque", () => {
    document.body.innerHTML = `<div id="app"></div>`;
    expect(() => readPayload()).toThrow(/application\/dbx-snapshot/);
  });

  it("throws on a payload that is not base64", () => {
    document.body.innerHTML = `<div id="app"></div><script type="application/dbx-snapshot">not base64 at all!</script>`;
    expect(() => readPayload()).toThrow();
    // The two failures must stay distinguishable: a document with no payload
    // and a document with a damaged one are different problems for whoever
    // produced the file. The decoder's own wording is not asserted — Chrome,
    // Firefox and Safari each phrase it differently — but it must not be
    // mistaken for the missing-element case. `main.spec.ts` covers what the
    // reader actually sees for both.
    expect(() => readPayload()).not.toThrow(/application\/dbx-snapshot/);
  });
});
