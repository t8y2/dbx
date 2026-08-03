// @vitest-environment happy-dom

import { strict as assert } from "node:assert";
import { afterEach, test, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

test("svgToPngBlob scales canvas, fills opaque background, and returns png blob", async () => {
  const fillRect = vi.fn();
  const drawImage = vi.fn();
  const toBlob = vi.fn((cb: (b: Blob | null) => void) => {
    cb(new Blob(["png"], { type: "image/png" }));
  });

  class FakeImage {
    naturalWidth = 100;
    naturalHeight = 50;
    width = 100;
    height = 50;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    fillStyle: "",
    fillRect,
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(toBlob as typeof HTMLCanvasElement.prototype.toBlob);

  const { svgToPngBlob } = await import("../../apps/desktop/src/lib/export/diagramFormats.ts");
  const blob = await svgToPngBlob('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>', 2);

  assert.equal(blob.type, "image/png");
  assert.equal(fillRect.mock.calls[0]?.slice(0, 4).join(","), "0,0,200,100");
  const ctx = HTMLCanvasElement.prototype.getContext.mock.results[0]?.value as { fillStyle: string };
  assert.equal(ctx.fillStyle, "#fafafa");
  assert.equal(drawImage.mock.calls.length, 1);
});

test("svgToPngBlob rejects when image fails to load", async () => {
  class FailingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_value: string) {
      queueMicrotask(() => this.onerror?.());
    }
  }
  vi.stubGlobal("Image", FailingImage);
  const { svgToPngBlob } = await import("../../apps/desktop/src/lib/export/diagramFormats.ts");
  await assert.rejects(() => svgToPngBlob("<svg/>", 2), /Failed to load SVG/);
});
