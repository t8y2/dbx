// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewLocale, restoreLocalePreview, setLocale } from "@/i18n";

describe("document language", () => {
  beforeEach(async () => {
    await setLocale("en");
    window.localStorage.clear();
  });

  afterEach(async () => {
    await setLocale("en");
    window.localStorage.clear();
  });

  it("follows the selected UI locale", async () => {
    expect(document.documentElement.lang).toBe("en");

    await setLocale("ru");
    expect(document.documentElement.lang).toBe("ru");

    await setLocale("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("follows transient locale previews and restores the selected locale", async () => {
    await setLocale("zh-CN");

    await previewLocale("ru");
    expect(document.documentElement.lang).toBe("ru");

    await restoreLocalePreview();
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("starts the static shell in the fallback locale instead of hardcoding one region", () => {
    const indexHtml = readFileSync(resolve(process.cwd(), "apps/desktop/index.html"), "utf8");
    expect(indexHtml).toContain('<html lang="en">');
  });
});
