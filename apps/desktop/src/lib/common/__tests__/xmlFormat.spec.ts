import { describe, expect, it } from "vitest";
import { formatXmlSource } from "../xmlFormat";

describe("formatXmlSource", () => {
  it("formats element-only XML while preserving attributes", () => {
    expect(formatXmlSource(`<root attr="a > b"><child/><child>value</child></root>`)).toBe(`<root attr="a > b">\n  <child/>\n  <child>value</child>\n</root>`);
  });

  it("preserves XML declarations, DOCTYPE subsets, comments, and CDATA", () => {
    const source = `<?xml version="1.0"?><!DOCTYPE root [<!ENTITY name "DBX">]><root><!-- note --><value><![CDATA[a < b]]></value></root>`;
    expect(formatXmlSource(source)).toBe(`<?xml version="1.0"?>\n<!DOCTYPE root [<!ENTITY name "DBX">]>\n<root>\n  <!-- note -->\n  <value><![CDATA[a < b]]></value>\n</root>`);
  });

  it("does not alter mixed content", () => {
    const source = `<p>Hello <em>there</em>, welcome.</p>`;
    expect(formatXmlSource(source)).toBe(source);
  });

  it("does not alter whitespace-only text nodes", () => {
    const source = `<p> <em/> </p>`;
    expect(formatXmlSource(source)).toBe(source);
  });

  it("rejects malformed XML", () => {
    expect(() => formatXmlSource(`<root><child></root>`)).toThrow(/closing tag/i);
    expect(() => formatXmlSource(`<root>`)).toThrow(/Unclosed/i);
  });
});
