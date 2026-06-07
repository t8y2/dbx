import { strict as assert } from "node:assert";
import test from "node:test";
import {
  imagePreviewFitScale,
  clampImagePreviewScale,
  imagePreviewTransform,
  nextImagePreviewScale,
} from "../../apps/desktop/src/lib/imagePreviewViewer.ts";

test("clamps image preview zoom to usable bounds", () => {
  assert.equal(clampImagePreviewScale(0.1), 0.2);
  assert.equal(clampImagePreviewScale(1.25), 1.25);
  assert.equal(clampImagePreviewScale(12), 8);
});

test("zooms in fixed steps from wheel direction", () => {
  assert.equal(nextImagePreviewScale(1, "in"), 1.2);
  assert.equal(nextImagePreviewScale(1, "out"), 0.8);
  assert.equal(nextImagePreviewScale(7.95, "in"), 8);
});

test("builds a stable CSS transform for image previews", () => {
  assert.equal(
    imagePreviewTransform({ scale: 1.5, offsetX: 12, offsetY: -8 }),
    "translate(12px, -8px) scale(1.5)",
  );
});

test("calculates fit scale from image and viewport dimensions", () => {
  assert.equal(
    imagePreviewFitScale({
      imageWidth: 2000,
      imageHeight: 1000,
      viewportWidth: 1000,
      viewportHeight: 800,
    }),
    0.45,
  );
  assert.equal(
    imagePreviewFitScale({
      imageWidth: 200,
      imageHeight: 100,
      viewportWidth: 1000,
      viewportHeight: 800,
    }),
    1,
  );
});
