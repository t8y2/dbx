import { strict as assert } from "node:assert";
import { test } from "vitest";
import { imagePreviewDialogSize } from "../../apps/desktop/src/lib/imagePreviewViewer.ts";

test("sizes wide image preview dialogs as landscape", () => {
  const size = imagePreviewDialogSize({
    imageWidth: 1600,
    imageHeight: 600,
    viewportWidth: 1200,
    viewportHeight: 900,
  });

  assert.ok(size);
  assert.ok(size.width > size.height);
  assert.ok(size.width > 384);
});

test("sizes tall image preview dialogs as portrait", () => {
  const size = imagePreviewDialogSize({
    imageWidth: 600,
    imageHeight: 1600,
    viewportWidth: 1200,
    viewportHeight: 900,
  });

  assert.ok(size);
  assert.ok(size.height > size.width);
});

test("keeps image preview dialogs inside viewport limits", () => {
  const size = imagePreviewDialogSize({
    imageWidth: 8000,
    imageHeight: 3000,
    viewportWidth: 1000,
    viewportHeight: 700,
  });

  assert.ok(size);
  assert.ok(size.width <= 920);
  assert.ok(size.height <= 602);
});

test("keeps very tall image preview dialogs wide enough for controls", () => {
  const size = imagePreviewDialogSize({
    imageWidth: 100,
    imageHeight: 3000,
    viewportWidth: 1200,
    viewportHeight: 900,
  });

  assert.ok(size);
  assert.ok(size.width >= 360);
  assert.ok(size.height <= 774);
});

test("keeps very wide image preview dialogs tall enough for controls", () => {
  const size = imagePreviewDialogSize({
    imageWidth: 3000,
    imageHeight: 100,
    viewportWidth: 1200,
    viewportHeight: 900,
  });

  assert.ok(size);
  assert.ok(size.width <= 1104);
  assert.ok(size.height >= 228);
});
