import { strict as assert } from "node:assert";
import { test } from "vitest";
import { cellImagePreviewUrl } from "../../apps/desktop/src/lib/cellImageUrl.ts";

test("detects obvious remote image URLs", () => {
  assert.equal(cellImagePreviewUrl("https://cdn.example.com/avatar/user.png"), "https://cdn.example.com/avatar/user.png");
  assert.equal(cellImagePreviewUrl(" https://cdn.example.com/photo.JPG?width=320#preview "), "https://cdn.example.com/photo.JPG?width=320#preview");
  assert.equal(cellImagePreviewUrl("https://cdn.example.com/image.webp"), "https://cdn.example.com/image.webp");
});

test("allows localhost HTTP image URLs for development data", () => {
  assert.equal(cellImagePreviewUrl("http://localhost:3000/image.gif"), "http://localhost:3000/image.gif");
  assert.equal(cellImagePreviewUrl("http://127.0.0.1:8080/image.jpg"), "http://127.0.0.1:8080/image.jpg");
});

test("rejects non-image and unsafe URLs", () => {
  assert.equal(cellImagePreviewUrl("https://example.com/page"), null);
  assert.equal(cellImagePreviewUrl("https://example.com/image.txt"), null);
  assert.equal(cellImagePreviewUrl("http://example.com/image.png"), null);
  assert.equal(cellImagePreviewUrl("file:///tmp/image.png"), null);
  assert.equal(cellImagePreviewUrl("javascript:alert(1)"), null);
  assert.equal(cellImagePreviewUrl(42), null);
  assert.equal(cellImagePreviewUrl(null), null);
});

test("detects safe data image URLs", () => {
  assert.equal(cellImagePreviewUrl("data:image/png;base64,abc123"), "data:image/png;base64,abc123");
  assert.equal(cellImagePreviewUrl("data:image/svg+xml;base64,abc123"), null);
});

test("detects binary image values from hex strings", () => {
  assert.match(cellImagePreviewUrl("0x89504e470d0a1a0a0000000d49484452", "longblob") ?? "", /^data:image\/png;base64,/);
  assert.match(cellImagePreviewUrl("0xffd8ffe000104a4649460001", "blob") ?? "", /^data:image\/jpeg;base64,/);
  assert.match(cellImagePreviewUrl("0x47494638396101000100", "blob") ?? "", /^data:image\/gif;base64,/);
  assert.match(cellImagePreviewUrl("0x524946461a00000057454250", "blob") ?? "", /^data:image\/webp;base64,/);
  assert.match(cellImagePreviewUrl("0x89504e470d0a1a0a0000000d49484452") ?? "", /^data:image\/png;base64,/);
  assert.match(cellImagePreviewUrl("89504e470d0a1a0a", "longblob") ?? "", /^data:image\/png;base64,/);
  assert.equal(cellImagePreviewUrl("89504e470d0a1a0a"), null);
});

test("can skip generated binary image previews while keeping URL previews", () => {
  assert.equal(cellImagePreviewUrl("0x89504e470d0a1a0a0000000d49484452", "longblob", { binary: false }), null);
  assert.equal(cellImagePreviewUrl("https://cdn.example.com/avatar.png", "longblob", { binary: false }), "https://cdn.example.com/avatar.png");
});

test("detects binary image values from byte arrays and buffer-like values", () => {
  assert.match(cellImagePreviewUrl([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ?? "", /^data:image\/png;base64,/);
  assert.match(cellImagePreviewUrl({ type: "Buffer", data: [0xff, 0xd8, 0xff, 0xe0] }) ?? "", /^data:image\/jpeg;base64,/);
});

test("detects safe binary SVG values and rejects active SVG content", () => {
  const svg = "0x3c73766720786d6c6e733d22687474703a2f2f7777772e77332e6f72672f323030302f737667223e3c2f7376673e";
  const scriptedSvg = "0x3c7376673e3c7363726970743e616c6572742831293c2f7363726970743e3c2f7376673e";
  assert.match(cellImagePreviewUrl(svg, "longblob") ?? "", /^data:image\/svg\+xml;base64,/);
  assert.equal(cellImagePreviewUrl(scriptedSvg, "longblob"), null);
});

test("skips very large binary image previews", () => {
  assert.equal(cellImagePreviewUrl(`0x${"00".repeat(8 * 1024 * 1024 + 1)}`, "longblob"), null);
});
