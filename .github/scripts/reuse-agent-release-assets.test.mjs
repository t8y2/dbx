import assert from "node:assert/strict";
import test from "node:test";

import { collectReusableAssetPlan } from "./reuse-agent-release-assets.mjs";

const platforms = [
  "macos-aarch64",
  "macos-x64",
  "linux-aarch64",
  "linux-x64",
  "windows-aarch64",
  "windows-x64",
];

test("collects complete reusable Java, native, and JRE assets", () => {
  const access = artifact("dbx-agent-access-0.1.34.tar.zst", "a");
  const kingbase = Object.fromEntries(
    platforms.map((platform, index) => [platform, artifact(`dbx-agent-kingbase-0.1.40-${platform}.tar.zst`, String(index + 1))]),
  );
  const jre = Object.fromEntries(
    platforms.map((platform, index) => [platform, artifact(`dbx-jre-21-${platform}.tar.zst`, String(index + 7))]),
  );
  const registry = {
    drivers: {
      access: { version: "0.1.34", jar: access },
      kingbase: { version: "0.1.40", native: kingbase },
    },
    jres: { 21: { version: "21.0.12", platforms: jre } },
  };
  const release = releaseFor([access, ...Object.values(kingbase), ...Object.values(jre)]);

  const plan = collectReusableAssetPlan({
    registry,
    release,
    versions: { access: "0.1.34", kingbase: "0.1.40" },
    modules: ["access", "kingbase"],
    reuseJre: true,
  });

  assert.equal(plan.driverAssets.length, 7);
  assert.equal(plan.jreAssets.length, 6);
  assert.deepEqual(plan.driverAssets.map((asset) => asset.moduleName), ["access", ...Array(6).fill("kingbase")]);
});

test("rejects an incomplete reusable native platform set", () => {
  const native = Object.fromEntries(
    platforms.slice(1).map((platform, index) => [platform, artifact(`dbx-agent-vastbase-0.1.38-${platform}.tar.zst`, String(index + 1))]),
  );
  const registry = { drivers: { vastbase: { version: "0.1.38", native } }, jres: {} };

  assert.throws(
    () => collectReusableAssetPlan({
      registry,
      release: releaseFor(Object.values(native)),
      versions: { vastbase: "0.1.38" },
      modules: ["vastbase"],
      reuseJre: false,
    }),
    /missing=macos-aarch64/,
  );
});

test("requires all TDengine native platforms when reusing a release", () => {
  const native = Object.fromEntries(
    platforms.slice(0, -1).map((platform, index) => [platform, artifact(`dbx-agent-tdengine-0.1.40-${platform}.tar.zst`, String(index + 1))]),
  );
  const registry = { drivers: { tdengine: { version: "0.1.40", native } }, jres: {} };

  assert.throws(
    () => collectReusableAssetPlan({
      registry,
      release: releaseFor(Object.values(native)),
      versions: { tdengine: "0.1.40" },
      modules: ["tdengine"],
      reuseJre: false,
    }),
    /missing=windows-x64/,
  );
});

test("requires all Neo4j native platforms when reusing a release", () => {
  const native = Object.fromEntries(
    platforms.slice(0, -1).map((platform, index) => [platform, artifact(`dbx-agent-neo4j-0.1.40-${platform}.tar.zst`, String(index + 1))]),
  );
  const registry = { drivers: { neo4j: { version: "0.1.40", native } }, jres: {} };

  assert.throws(
    () => collectReusableAssetPlan({
      registry,
      release: releaseFor(Object.values(native)),
      versions: { neo4j: "0.1.40" },
      modules: ["neo4j"],
      reuseJre: false,
    }),
    /missing=windows-x64/,
  );
});

test("requires all IoTDB native platforms when reusing a release", () => {
  const native = Object.fromEntries(
    platforms.slice(0, -1).map((platform, index) => [platform, artifact(`dbx-agent-iotdb-0.1.30-${platform}.tar.zst`, String(index + 1))]),
  );
  const registry = { drivers: { iotdb: { version: "0.1.30", native } }, jres: {} };

  assert.throws(
    () => collectReusableAssetPlan({
      registry,
      release: releaseFor(Object.values(native)),
      versions: { iotdb: "0.1.30" },
      modules: ["iotdb"],
      reuseJre: false,
    }),
    /missing=windows-x64/,
  );
});

test("ignores zero-size legacy JAR placeholders for native-only modules", () => {
  const native = Object.fromEntries(
    platforms.map((platform, index) => [platform, artifact(`dbx-agent-duckdb-0.1.2-${platform}.tar.zst`, String(index + 1))]),
  );
  const registry = {
    drivers: {
      duckdb: {
        version: "0.1.2",
        jar: {
          url: "https://example.invalid/dbx-agent-duckdb-legacy-placeholder.jar",
          size: 0,
          sha256: "",
        },
        native,
      },
    },
    jres: {},
  };

  const plan = collectReusableAssetPlan({
    registry,
    release: releaseFor(Object.values(native)),
    versions: { duckdb: "0.1.2" },
    modules: ["duckdb"],
    reuseJre: false,
  });

  assert.equal(plan.driverAssets.length, 6);
  assert.equal(plan.driverAssets.some((asset) => asset.kind === "jar"), false);
});

test("rejects a registry version that differs from the effective baseline", () => {
  const access = artifact("dbx-agent-access-0.1.33.tar.zst", "a");
  const registry = { drivers: { access: { version: "0.1.33", jar: access } }, jres: {} };

  assert.throws(
    () => collectReusableAssetPlan({
      registry,
      release: releaseFor([access]),
      versions: { access: "0.1.34" },
      modules: ["access"],
      reuseJre: false,
    }),
    /registry=0\.1\.33, expected=0\.1\.34/,
  );
});

function artifact(name, seed) {
  return { url: `https://example.invalid/${name}`, size: 100, sha256: seed.repeat(64).slice(0, 64) };
}

function releaseFor(artifacts) {
  return {
    assets: artifacts.map((entry) => ({
      name: entry.url.split("/").at(-1),
      size: entry.size,
      digest: `sha256:${entry.sha256}`,
    })),
  };
}
