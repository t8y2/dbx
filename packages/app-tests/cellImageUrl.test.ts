import { strict as assert } from "node:assert";
import test from "node:test";
import { cellImagePreviewUrl } from "../../apps/desktop/src/lib/cellImageUrl.ts";

test("detects obvious remote image URLs", () => {
  assert.equal(cellImagePreviewUrl("https://cdn.example.com/avatar/user.png"), "https://cdn.example.com/avatar/user.png");
  assert.equal(
    cellImagePreviewUrl(" https://cdn.example.com/photo.JPG?width=320#preview "),
    "https://cdn.example.com/photo.JPG?width=320#preview",
  );
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
