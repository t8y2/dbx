import { strict as assert } from "node:assert";
import { test } from "vitest";
import {
  buildElasticsearchExternalConfig,
  elasticsearchConnectionModeFromConfig,
  elasticsearchKibanaBasePathFromConfig,
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
