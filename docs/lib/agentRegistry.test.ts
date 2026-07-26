import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import driverVersions from "../../agents/versions.json";
import { buildAgentDownloadCatalog, buildDriverEntries, buildNativeAgentEntries, downloadLinksFor, fetchAgentDownloadCatalog, formatSize } from "./agentRegistry";

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

test("versioned release assets expose GitHub and CNB download links", () => {
  assert.deepEqual(downloadLinksFor("https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-agents-offline-macos-aarch64.zip"), [
    { source: "github", url: "https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-agents-offline-macos-aarch64.zip" },
    { source: "cnb", url: "https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-v0.2.64/dbx-agents-offline-macos-aarch64.zip" },
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
      if (url.includes("api.github.com")) {
        return Response.json({
          assets: [
            {
              name: "agent-registry.json",
              size: 1,
              browser_download_url: "https://github.com/t8y2/dbx/releases/download/agents-latest/agent-registry.json",
            },
          ],
        });
      }
      return Response.json({
        drivers: {
          access: {
            version: "0.1.30",
            jar: {
              url: "https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-agent-access-0.1.30.jar",
              size: 1,
            },
          },
        },
        jres: {
          "21": {
            platforms: {
              "macos-aarch64": {
                url: "https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-jre-21-macos-aarch64.tar.gz",
                size: 1,
              },
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
  assert.equal(
    catalog?.bundles[0]?.url,
    "https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-agents-offline-macos-aarch64.zip",
  );
});

test("unknown fallback asset sizes render as unavailable", () => {
  assert.equal(formatSize(0), "—");
});

test("Java agent ZIPs are preferred over raw JARs", () => {
  const accessVersion = driverVersions.access;
  const entries = buildDriverEntries([
    {
      name: `dbx-agent-access-${accessVersion}.jar`,
      browser_download_url: `https://example.com/dbx-agent-access-${accessVersion}.jar`,
      size: 1024,
    },
    {
      name: `dbx-agent-access-${accessVersion}.zip`,
      browser_download_url: `https://example.com/dbx-agent-access-${accessVersion}.zip`,
      size: 2048,
    },
  ]);

  assert.equal(entries[0]?.key, "access");
  assert.equal(entries[0]?.jar.url, `https://example.com/dbx-agent-access-${accessVersion}.zip`);
});

test("KingBase native ZIPs are preferred over raw release executables", () => {
  const entries = buildNativeAgentEntries([
    {
      name: "dbx-agent-kingbase-windows-x64.exe",
      browser_download_url: "https://example.com/dbx-agent-kingbase-windows-x64.exe",
      size: 1024,
    },
    {
      name: "dbx-agent-kingbase-0.1.34-windows-x64.exe",
      browser_download_url: "https://example.com/dbx-agent-kingbase-0.1.34-windows-x64.exe",
      size: 2048,
    },
    {
      name: "dbx-agent-kingbase-0.1.34-windows-x64.zip",
      browser_download_url: "https://example.com/dbx-agent-kingbase-0.1.34-windows-x64.zip",
      size: 4096,
    },
    {
      name: "dbx-agent-kingbase-0.1.34-linux-x64.zip",
      browser_download_url: "https://example.com/dbx-agent-kingbase-0.1.34-linux-x64.zip",
      size: 3072,
    },
  ]);

  assert.deepEqual(
    entries.map(({ key, version, platformKey, filename }) => ({ key, version, platformKey, filename })),
    [
      {
        key: "kingbase",
        version: "0.1.34",
        platformKey: "linux-x64",
        filename: "dbx-agent-kingbase-0.1.34-linux-x64.zip",
      },
      {
        key: "kingbase",
        version: "0.1.34",
        platformKey: "windows-x64",
        filename: "dbx-agent-kingbase-0.1.34-windows-x64.zip",
      },
    ],
  );
});
