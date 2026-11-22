// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { buildStaticHtmlPreview } from "../safeHtmlPreview";

it("preserves the static content of database HTML previews", () => {
  const html = buildStaticHtmlPreview('<p><strong>Example</strong> <a href="https://example.invalid">link text</a></p><meta name="description" content="unused">');
  expect(html).toContain("<strong>Example</strong>");
  expect(html).toContain("<a>link text</a>");
  expect(html).toContain("<div inert>");
  expect(html).not.toContain("example.invalid");
  expect(html).not.toContain('name="description"');
});
