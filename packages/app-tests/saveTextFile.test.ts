import { strict as assert } from "node:assert";
import { afterEach, beforeEach, test, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({ isTauri: false }));
const dialogMock = vi.hoisted(() => ({ save: vi.fn() }));
const fsMock = vi.hoisted(() => ({ writeTextFile: vi.fn() }));

vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => runtimeMock.isTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialogMock.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: fsMock.writeTextFile }));

const { saveTextFile, sanitizeExportBaseName, compactLocalTimestamp } = await import(
  "../../apps/desktop/src/lib/export/saveTextFile.ts"
);

function installTextDownloadCapture() {
  let downloadedBlob: Blob | undefined;
  let anchorHref = "";
  let anchorDownload = "";
  const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    downloadedBlob = blob as Blob;
    return "blob:test-export";
  });
  const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const anchorClick = vi.fn();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: (_tag: string) => {
        const a = { click: anchorClick, href: "", download: "" };
        // Capture property assignments so assertions can verify them
        const proxy = new Proxy(a, {
          set(target, prop, value) {
            (target as any)[prop] = value;
            if (prop === "href") anchorHref = value;
            if (prop === "download") anchorDownload = value;
            return true;
          },
        });
        return proxy;
      },
    },
  });
  return {
    content: async () => downloadedBlob?.text(),
    anchorDownload: () => anchorDownload,
    restore: () => {
      createObjectUrl.mockRestore();
      revokeObjectUrl.mockRestore();
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtimeMock.isTauri = false;
  dialogMock.save.mockResolvedValue(null);
  fsMock.writeTextFile.mockResolvedValue(undefined);
});

// --- saveTextFile Tauri path ---

test("Tauri save writes content to the user-chosen path", async () => {
  runtimeMock.isTauri = true;
  dialogMock.save.mockResolvedValue("C:/out/name.md");

  await saveTextFile("hello world", "name.md", "Markdown", "md");

  assert.equal(dialogMock.save.mock.calls.length, 1);
  assert.deepEqual(dialogMock.save.mock.calls[0][0], {
    defaultPath: "name.md",
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  assert.equal(fsMock.writeTextFile.mock.calls.length, 1);
  assert.equal(fsMock.writeTextFile.mock.calls[0][0], "C:/out/name.md");
  assert.equal(fsMock.writeTextFile.mock.calls[0][1], "hello world");
});

test("Tauri cancel does not write anything", async () => {
  runtimeMock.isTauri = true;
  dialogMock.save.mockResolvedValue(null);

  await saveTextFile("hello world", "name.md", "Markdown", "md");

  assert.equal(dialogMock.save.mock.calls.length, 1);
  assert.equal(fsMock.writeTextFile.mock.calls.length, 0);
});

test("Tauri write failure rejects the caller", async () => {
  runtimeMock.isTauri = true;
  dialogMock.save.mockResolvedValue("C:/out/name.md");
  fsMock.writeTextFile.mockRejectedValue(new Error("disk full"));

  await assert.rejects(
    () => saveTextFile("hello world", "name.md", "Markdown", "md"),
    { message: "disk full" },
  );

  assert.equal(dialogMock.save.mock.calls.length, 1);
  assert.equal(fsMock.writeTextFile.mock.calls.length, 1);
});

// --- saveTextFile Web path ---

test("Web download creates a Blob and triggers a link click", async () => {
  runtimeMock.isTauri = false;
  const download = installTextDownloadCapture();

  try {
    await saveTextFile("hello world", "name.md", "Markdown", "md");

    const text = await download.content();
    assert.equal(text, "hello world");
    // The fake anchor element should have its download attribute set
    assert.equal(download.anchorDownload(), "name.md");
  } finally {
    download.restore();
  }
});

// --- sanitizeExportBaseName ---

test("sanitizeExportBaseName replaces illegal file-system characters with underscores", () => {
  assert.equal(sanitizeExportBaseName('a<b>c:"d/e\\f|g?h*i'), "a_b_c__d_e_f_g_h_i");
});

test("sanitizeExportBaseName strips trailing .sql extension (case-insensitive)", () => {
  assert.equal(sanitizeExportBaseName("daily/report.SQL"), "daily_report");
  assert.equal(sanitizeExportBaseName("daily/report.Sql"), "daily_report");
  assert.equal(sanitizeExportBaseName("daily/report.sqL"), "daily_report");
  assert.equal(sanitizeExportBaseName("middle.SQL.ends"), "middle.SQL.ends");
});

test("sanitizeExportBaseName trims trailing dots, underscores, spaces, and hyphens", () => {
  assert.equal(sanitizeExportBaseName("trailing-._ -"), "trailing");
  assert.equal(sanitizeExportBaseName("trailing._ -_.sql"), "trailing");
});

test("sanitizeExportBaseName collapses consecutive whitespace", () => {
  assert.equal(sanitizeExportBaseName("hello   world"), "hello world");
  // tab (char code 9) is a control character and replaced by _, not collapsed as whitespace
  assert.equal(sanitizeExportBaseName("a\tb"), "a_b");
});

test("sanitizeExportBaseName truncates to 120 characters", () => {
  const long = "a".repeat(200);
  assert.equal(sanitizeExportBaseName(long).length, 120);
  // trailing chars removed after truncation should not leave dangling punctuation
  assert.match(sanitizeExportBaseName(long), /a+$/);
});

test("sanitizeExportBaseName replaces control characters", () => {
  assert.equal(
    sanitizeExportBaseName("a" + String.fromCharCode(0) + "b" + String.fromCharCode(1) + "c"),
    "a_b_c",
  );
});

test("sanitizeExportBaseName returns empty string for all-illegal input", () => {
  assert.equal(sanitizeExportBaseName("<>?*.sql"), "");
  assert.equal(sanitizeExportBaseName(".:."), "");
});

// --- compactLocalTimestamp ---

test("compactLocalTimestamp formats a date as YYMMDDHHmmss", () => {
  const d = new Date(2026, 5, 2, 15, 4, 5); // June 2, 2026 15:04:05
  assert.equal(compactLocalTimestamp(d), "260602150405");
});

test("compactLocalTimestamp pads single-digit values", () => {
  const d = new Date(2026, 0, 1, 2, 3, 4); // Jan 1, 2026 02:03:04
  assert.equal(compactLocalTimestamp(d), "260101020304");
});

test("compactLocalTimestamp uses current time when no argument is given", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2025, 11, 31, 23, 59, 59));
    assert.equal(compactLocalTimestamp(), "251231235959");
  } finally {
    vi.useRealTimers();
  }
});
