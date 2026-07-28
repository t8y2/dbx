import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildElasticsearchExternalConfig,
  elasticsearchConnectionModeFromConfig,
  elasticsearchConnectivityCheckPathFromConfig,
  elasticsearchKibanaBasePathFromConfig,
  normalizeElasticsearchConnectivityCheckPath,
  normalizeKibanaBasePath,
} from "../../apps/desktop/src/lib/connection/elasticsearchKibanaProxy.ts";

test("keeps existing Elasticsearch connections in direct mode", () => {
  assert.equal(elasticsearchConnectionModeFromConfig(undefined), "direct");
  assert.equal(elasticsearchConnectionModeFromConfig({ mode: "direct" }), "direct");
  assert.equal(buildElasticsearchExternalConfig("direct", "/kibana"), undefined);
});

test("round trips Kibana proxy mode and normalizes its base path", () => {
  const config = buildElasticsearchExternalConfig("kibana", " kibana/s/analytics/ ");

  assert.deepEqual(config, { mode: "kibana", kibanaBasePath: "/kibana/s/analytics" });
  assert.equal(elasticsearchConnectionModeFromConfig(config), "kibana");
  assert.equal(elasticsearchKibanaBasePathFromConfig(config), "/kibana/s/analytics");
  assert.equal(normalizeKibanaBasePath("/"), "");
});

test("stores connectivity check path for direct and kibana modes", () => {
  assert.equal(normalizeElasticsearchConnectivityCheckPath(""), "");
  assert.equal(normalizeElasticsearchConnectivityCheckPath("/"), "");
  assert.equal(normalizeElasticsearchConnectivityCheckPath("GET pro-logs-*/_search"), "/pro-logs-*/_search");
  assert.equal(normalizeElasticsearchConnectivityCheckPath("pro-logs-*/_search"), "/pro-logs-*/_search");

  const direct = buildElasticsearchExternalConfig("direct", "", "GET pro-logs-*/_search");
  assert.deepEqual(direct, { connectivityCheckPath: "/pro-logs-*/_search" });
  assert.equal(elasticsearchConnectivityCheckPathFromConfig(direct), "/pro-logs-*/_search");

  const kibana = buildElasticsearchExternalConfig("kibana", "/kibana", "my-index/_search");
  assert.deepEqual(kibana, {
    mode: "kibana",
    kibanaBasePath: "/kibana",
    connectivityCheckPath: "/my-index/_search",
  });
});
