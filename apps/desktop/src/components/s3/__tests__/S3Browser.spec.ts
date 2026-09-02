// @vitest-environment happy-dom

import { createApp, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import S3Browser from "../S3Browser.vue";

const apiMocks = vi.hoisted(() => ({
  s3ListBuckets: vi.fn(),
  s3ListObjects: vi.fn(),
  s3PreviewObject: vi.fn(),
  s3CreateBucket: vi.fn(),
  s3DeleteObject: vi.fn(),
  s3UploadObject: vi.fn(),
}));

const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/backend/api", () => apiMocks);
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ toast: toastMock }) }));

async function flushUi() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

describe("S3Browser", () => {
  afterEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("loads additional pages with the continuation token", async () => {
    apiMocks.s3ListBuckets.mockResolvedValue([{ name: "demo-bucket", creationDate: "2026-08-19T00:00:00Z" }]);
    apiMocks.s3ListObjects
      .mockResolvedValueOnce({
        objects: Array.from({ length: 200 }, (_, index) => ({
          key: `folder/object-${index.toString().padStart(3, "0")}.txt`,
          size: index + 1,
        })),
        prefixes: [],
        isTruncated: true,
        nextContinuationToken: "page-2",
      })
      .mockResolvedValueOnce({
        objects: [{ key: "folder/object-200.txt", size: 201 }],
        prefixes: [{ prefix: "folder/archive/" }],
        isTruncated: false,
        nextContinuationToken: null,
      });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = createApp(S3Browser, { connectionId: "conn-s3" });
    app.use(i18n);
    app.mount(host);
    await flushUi();
    await flushUi();

    expect(apiMocks.s3ListObjects).toHaveBeenCalledWith("conn-s3", "demo-bucket", "", "/", 200, null);
    expect(host.textContent).toContain("object-199.txt");
    expect(host.textContent).not.toContain("object-200.txt");

    const loadMoreButton = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("Load more"));
    expect(loadMoreButton).toBeTruthy();
    loadMoreButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushUi();
    await flushUi();

    expect(apiMocks.s3ListObjects).toHaveBeenLastCalledWith("conn-s3", "demo-bucket", "", "/", 200, "page-2");
    expect(host.textContent).toContain("object-200.txt");
    expect(host.textContent).toContain("archive/");

    app.unmount();
  });
});
