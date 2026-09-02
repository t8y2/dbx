import assert from "node:assert/strict";
import { test } from "vitest";

import { createInstallOptions } from "./downloadLinks";

test("Windows downloads include standard, offline, and Windows 7 installers", () => {
  const windowsOptions = createInstallOptions("cn", "0.5.82").filter((option) => option.id.startsWith("windows"));

  assert.deepEqual(
    windowsOptions.map(({ id, iconId, label, description, driverLinkLabel, descriptionSuffix, badge, href }) => ({
      id,
      iconId,
      label,
      description,
      driverLinkLabel,
      descriptionSuffix,
      badge,
      href,
    })),
    [
      {
        id: "windows",
        iconId: "windows",
        label: "Windows 10/11 (x64)",
        description: "标准在线安装包",
        driverLinkLabel: undefined,
        descriptionSuffix: undefined,
        badge: "推荐",
        href: "https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_x64-setup.exe?v=0.5.82",
      },
      {
        id: "windows-offline",
        iconId: "windows",
        label: "Windows10内网环境安装包",
        description: "内置 WebView2 离线运行库 · 不含",
        driverLinkLabel: "数据库离线驱动",
        descriptionSuffix: undefined,
        badge: "内网",
        href: "https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_x64-webview2-offline-setup.exe?v=0.5.82",
      },
      {
        id: "windows-7-offline",
        iconId: "windows-legacy",
        label: "Windows 7 / Server\u00a02012\u00a0R2 专用包",
        description: "内置 WebView2 离线运行库 · 不含",
        driverLinkLabel: "数据库离线驱动",
        descriptionSuffix: undefined,
        badge: "旧系统",
        href: "https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_x64-win7-server2012r2-webview2-109-offline-setup.exe?v=0.5.82",
      },
    ],
  );
});

test("all downloads use immutable versioned release paths", () => {
  const options = createInstallOptions("en", "0.5.82");

  assert.equal(options.length, 8);
  assert.ok(options.every((option) => option.href.startsWith("https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_")));
  assert.ok(options.every((option) => !option.href.includes("/releases/latest/")));
});

test("browser static package opens one guide with both architecture downloads", () => {
  const options = createInstallOptions("cn", "0.6.0").filter((option) => option.action === "instructions");

  assert.deepEqual(
    options.map(({ id, iconId, label, href, browserStaticDownloads }) => ({ id, iconId, label, href, browserStaticDownloads })),
    [
      {
        id: "linux-browser",
        iconId: "linux",
        label: "Linux 浏览器版",
        href: "https://dl.dbxio.com/releases/v0.6.0/DBX_0.6.0_x64-browser-static.tar.gz?v=0.6.0",
        browserStaticDownloads: [
          {
            arch: "x64",
            href: "https://dl.dbxio.com/releases/v0.6.0/DBX_0.6.0_x64-browser-static.tar.gz?v=0.6.0",
          },
          {
            arch: "arm64",
            href: "https://dl.dbxio.com/releases/v0.6.0/DBX_0.6.0_arm64-browser-static.tar.gz?v=0.6.0",
          },
        ],
      },
    ],
  );
});
