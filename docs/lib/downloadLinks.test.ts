import assert from "node:assert/strict";
import { test } from "vitest";

import { createInstallOptions } from "./downloadLinks";

test("Windows downloads include standard, offline, and Windows 7 installers", () => {
  const windowsOptions = createInstallOptions("cn", "0.5.82").filter((option) => option.iconId === "windows");

  assert.deepEqual(
    windowsOptions.map(({ id, label, description, badge, href }) => ({ id, label, description, badge, href })),
    [
      {
        id: "windows",
        label: "Windows 10/11 (x64)",
        description: "标准在线安装包",
        badge: "推荐",
        href: "https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_x64-setup.exe?v=0.5.82",
      },
      {
        id: "windows-offline",
        label: "Windows 完整离线安装包",
        description: "内置 WebView2 · 适用于内网部署或运行库缺失",
        badge: "离线",
        href: "https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_x64-webview2-offline-setup.exe?v=0.5.82",
      },
      {
        id: "windows-7-offline",
        label: "Windows 7 / Server 2012 R2 离线安装包",
        description: "内置 WebView2 109 · 仅支持 x64",
        badge: "旧系统",
        href: "https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_x64-win7-server2012r2-webview2-109-offline-setup.exe?v=0.5.82",
      },
    ],
  );
});

test("all downloads use immutable versioned release paths", () => {
  const options = createInstallOptions("en", "0.5.82");

  assert.equal(options.length, 7);
  assert.ok(options.every((option) => option.href.startsWith("https://dl.dbxio.com/releases/v0.5.82/DBX_0.5.82_")));
  assert.ok(options.every((option) => !option.href.includes("/releases/latest/")));
});
