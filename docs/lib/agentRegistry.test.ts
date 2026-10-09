import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import driverVersions from "../../agents/versions.json";
import { buildAgentDownloadCatalog, buildDriverEntries, buildNativeAgentEntries, downloadLinksFor, formatSize, selectNativeAgentPlatform } from "./agentRegistry";
import { fetchAgentDownloadCatalog } from "./agentRegistrySource";

afterEach(() => {
  vi.restoreAllMocks();
});

const availablePlatforms = ["linux-aarch64", "linux-x64", "macos-aarch64", "macos-x64", "windows-aarch64", "windows-x64"].map((platformKey) => ({ platformKey }));

for (const { platformKey } of availablePlatforms) {
  test(`native Agent defaults to the detected ${platformKey} platform`, () => {
    assert.equal(selectNativeAgentPlatform(availablePlatforms, platformKey), platformKey);
  });
}

test("async ARM refinement updates the automatic default", () => {
  const initial = selectNativeAgentPlatform(availablePlatforms, "macos-x64");
  assert.equal(selectNativeAgentPlatform(availablePlatforms, "macos-aarch64", initial), "macos-aarch64");
});

test("async refinement preserves a platform selected manually for another machine", () => {
  assert.equal(selectNativeAgentPlatform(availablePlatforms, "macos-aarch64", "windows-x64", true), "windows-x64");
  assert.equal(selectNativeAgentPlatform(availablePlatforms, "macos-aarch64", "macos-x64", true), "macos-x64");
});

test("unsupported and unknown platforms fall back to an available artifact", () => {
  const windowsOnly = [{ platformKey: "windows-x64" }];
  assert.equal(selectNativeAgentPlatform(windowsOnly, "macos-aarch64"), "windows-x64");
  assert.equal(selectNativeAgentPlatform(availablePlatforms, null), "linux-aarch64");
  assert.equal(selectNativeAgentPlatform(availablePlatforms, "unknown"), "linux-aarch64");
  assert.equal(selectNativeAgentPlatform(availablePlatforms, "windows-x64", "removed-platform", true), "windows-x64");
  assert.equal(selectNativeAgentPlatform([], "macos-aarch64"), undefined);
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
  assert.deepEqual(downloadLinksFor("https://dl.dbxio.com/releases/latest/dbx-jdbc-plugin-latest.zip"), [{ source: "official", url: "https://dl.dbxio.com/releases/latest/dbx-jdbc-plugin-latest.zip" }]);
});

test("catalog falls back from R2 to CNB without using GitHub API", async () => {
  const requestedUrls: string[] = [];
  const accessVersion = "9.9.9";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url === "https://dl.dbxio.com/agents/agent-registry.json") {
        return new Response("registry unavailable", { status: 503 });
      }
      return Response.json({
        drivers: {
          access: {
            version: accessVersion,
            jar: {
              url: `https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-agent-access-${accessVersion}.tar.zst`,
              size: 1,
              format: "tar_zstd",
            },
          },
        },
        jres: {
          "21": {
            platforms: {
              "macos-aarch64": {
                url: "https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-jre-21-macos-aarch64.tar.zst",
                size: 1,
                format: "tar_zstd",
              },
            },
          },
        },
      });
    }),
  );

  const catalog = await fetchAgentDownloadCatalog();

  assert.deepEqual(requestedUrls, ["https://dl.dbxio.com/agents/agent-registry.json", "https://cnb.cool/dbxio.com/dbx/-/releases/download/agents-latest/agent-registry.json"]);
  assert.equal(catalog?.drivers[0]?.key, "access");
  assert.equal(catalog?.drivers[0]?.version, accessVersion);
  assert.equal(catalog?.jres[0]?.platformKey, "macos-aarch64");
  assert.equal(catalog?.bundles[0]?.platformKey, "macos-aarch64");
  assert.equal(catalog?.bundles[0]?.url, "https://github.com/t8y2/dbx/releases/download/agents-v0.2.64/dbx-agents-offline-macos-aarch64.zip");
});

test("unknown fallback asset sizes render as unavailable", () => {
  assert.equal(formatSize(0), "—");
});

test("Java agent tar.zst packages are preferred over raw JARs", () => {
  const accessVersion = driverVersions.access;
  const entries = buildDriverEntries([
    {
      name: `dbx-agent-access-${accessVersion}.jar`,
      browser_download_url: `https://example.com/dbx-agent-access-${accessVersion}.jar`,
      size: 1024,
    },
    {
      name: `dbx-agent-access-${accessVersion}.tar.zst`,
      browser_download_url: `https://example.com/dbx-agent-access-${accessVersion}.tar.zst`,
      size: 2048,
    },
  ]);

  assert.equal(entries[0]?.key, "access");
  assert.equal(entries[0]?.jar.url, `https://example.com/dbx-agent-access-${accessVersion}.tar.zst`);
});

test("KingBase native tar.zst packages are preferred over raw release executables", () => {
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
      name: "dbx-agent-kingbase-0.1.34-windows-x64.tar.zst",
      browser_download_url: "https://example.com/dbx-agent-kingbase-0.1.34-windows-x64.tar.zst",
      size: 4096,
    },
    {
      name: "dbx-agent-kingbase-0.1.34-linux-x64.tar.zst",
      browser_download_url: "https://example.com/dbx-agent-kingbase-0.1.34-linux-x64.tar.zst",
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
        filename: "dbx-agent-kingbase-0.1.34-linux-x64.tar.zst",
      },
      {
        key: "kingbase",
        version: "0.1.34",
        platformKey: "windows-x64",
        filename: "dbx-agent-kingbase-0.1.34-windows-x64.tar.zst",
      },
    ],
  );
});

test("DuckDB native tar.zst packages appear in the native catalog", () => {
  const entries = buildNativeAgentEntries([
    {
      name: "dbx-agent-duckdb-0.1.0-macos-aarch64.tar.zst",
      browser_download_url: "https://example.com/dbx-agent-duckdb-0.1.0-macos-aarch64.tar.zst",
      size: 4096,
    },
  ]);

  assert.deepEqual(
    entries.map(({ key, platformKey, filename }) => ({ key, platformKey, filename })),
    [
      {
        key: "duckdb",
        platformKey: "macos-aarch64",
        filename: "dbx-agent-duckdb-0.1.0-macos-aarch64.tar.zst",
      },
    ],
  );
});

test("RabbitMQ native tar.zst packages appear in the native catalog", () => {
  const entries = buildNativeAgentEntries([
    {
      name: "dbx-agent-rabbitmq-0.1.1-windows-x64.tar.zst",
      browser_download_url: "https://example.com/dbx-agent-rabbitmq-0.1.1-windows-x64.tar.zst",
      size: 4096,
    },
  ]);

  assert.deepEqual(
    entries.map(({ key, platformKey, filename }) => ({ key, platformKey, filename })),
    [
      {
        key: "rabbitmq",
        platformKey: "windows-x64",
        filename: "dbx-agent-rabbitmq-0.1.1-windows-x64.tar.zst",
      },
    ],
  );
  assert.equal(entries[0]?.label, "RabbitMQ");
});

test("all current native-only agent packages appear in the native catalog", () => {
  const nativeKeys = ["cassandra", "duckdb", "hive", "iotdb", "kingbase", "neo4j", "oracle", "oracle-oci", "rabbitmq", "rocketmq", "tdengine", "vastbase", "xugu", "zookeeper"];
  const entries = buildNativeAgentEntries(
    nativeKeys.map((key) => ({
      name: `dbx-agent-${key}-${driverVersions[key as keyof typeof driverVersions]}-macos-aarch64.tar.zst`,
      browser_download_url: `https://example.com/dbx-agent-${key}-macos-aarch64.tar.zst`,
      size: 4096,
    })),
  );

  assert.deepEqual(entries.map(({ key }) => key).sort(), nativeKeys);
  assert.equal(entries.find(({ key }) => key === "cassandra")?.label, "Apache Cassandra");
  assert.equal(entries.find(({ key }) => key === "hive")?.label, "Apache Hive");
  assert.equal(entries.find(({ key }) => key === "rocketmq")?.label, "Apache RocketMQ");
  assert.equal(entries.find(({ key }) => key === "zookeeper")?.label, "Apache ZooKeeper");
  assert.equal(entries.find(({ key }) => key === "oracle")?.label, "Oracle");
  // The OCI (thick driver) agent is a separate package from the thin one.
  assert.equal(entries.find(({ key }) => key === "oracle-oci")?.label, "Oracle (OCI)");
});
