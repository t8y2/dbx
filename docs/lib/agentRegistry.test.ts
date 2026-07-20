import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { buildAgentDownloadCatalog, buildNativeAgentEntries, downloadLinksFor, fetchAgentDownloadCatalog, formatSize } from "./agentRegistry";

afterEach(() => {
  vi.restoreAllMocks();
});

test("offline download catalog includes the JDBC plugin ZIP", () => {
  const catalog = buildAgentDownloadCatalog([]);

  assert.deepEqual(catalog.jdbcPlugin, {
    label: "DBX JDBC Plugin",
    filename: "dbx-jdbc-plugin-latest.zip",
    url: "https://dl.dbxio.com/releases/latest/dbx-jdbc-plugin-latest.zip",
  });
});

test("release assets expose GitHub and CNB download links", () => {
  assert.deepEqual(downloadLinksFor("https://github.com/t8y2/dbx/releases/download/agents-latest/dbx-agents-offline-macos-aarch64.zip"), [
    { source: "github", url: "https://github.com/t8y2/dbx/releases/download/agents-latest/dbx-agents-offline-macos-aarch64.zip" },
    { source: "cnb", url: "https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-latest/dbx-agents-offline-macos-aarch64.zip" },
  ]);
});

test("non-release assets retain their official download link", () => {
  assert.deepEqual(downloadLinksFor("https://dl.dbxio.com/releases/latest/dbx-jdbc-plugin-latest.zip"), [
    { source: "official", url: "https://dl.dbxio.com/releases/latest/dbx-jdbc-plugin-latest.zip" },
  ]);
});

test("catalog falls back from GitHub to CNB", async () => {
  const requestedUrls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("api.github.com")) return new Response("rate limited", { status: 403 });
      return Response.json({
        drivers: {
          access: { jar: { url: "https://dl.dbxio.com/agents/dbx-agent-access.jar", size: 1 } },
        },
        jres: {
          "21": {
            platforms: {
              "macos-aarch64": { url: "https://dl.dbxio.com/jres/dbx-jre-21-macos-aarch64.tar.gz", size: 1 },
            },
          },
        },
      });
    }),
  );

  const catalog = await fetchAgentDownloadCatalog();

  assert.deepEqual(requestedUrls, [
    "https://api.github.com/repos/t8y2/dbx/releases/tags/agents-latest",
    "https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-latest/agent-registry.json",
  ]);
  assert.equal(catalog?.drivers[0]?.key, "access");
  assert.equal(catalog?.jres[0]?.platformKey, "macos-aarch64");
  assert.equal(catalog?.bundles[0]?.platformKey, "macos-aarch64");
});

test("unknown fallback asset sizes render as unavailable", () => {
  assert.equal(formatSize(0), "—");
});

test("KingBase release executables are listed as native agents", () => {
  const entries = buildNativeAgentEntries([
    {
      name: "dbx-agent-kingbase-windows-x64.exe",
      browser_download_url: "https://example.com/dbx-agent-kingbase-windows-x64.exe",
      size: 1024,
    },
    {
      name: "dbx-agent-kingbase-linux-x64",
      browser_download_url: "https://example.com/dbx-agent-kingbase-linux-x64",
      size: 2048,
    },
    {
      name: "dbx-agent-kingbase.jar",
      browser_download_url: "https://example.com/dbx-agent-kingbase.jar",
      size: 4096,
    },
  ]);

  assert.deepEqual(
    entries.map(({ key, platformKey, filename }) => ({ key, platformKey, filename })),
    [
      { key: "kingbase", platformKey: "linux-x64", filename: "dbx-agent-kingbase-linux-x64" },
      { key: "kingbase", platformKey: "windows-x64", filename: "dbx-agent-kingbase-windows-x64.exe" },
    ],
  );
});
