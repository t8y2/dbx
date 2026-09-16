import { describe, expect, it } from "vitest";
import { buildElasticsearchExternalConfig, elasticsearchConnectivityCheckDisabledFromConfig } from "@/lib/connection/elasticsearchKibanaProxy";

describe("Elasticsearch connectivity-check configuration", () => {
  it.each([true, "true", "TRUE", "1", "yes", "YES", "on", "ON"])("reads enabled value %j", (value) => {
    expect(elasticsearchConnectivityCheckDisabledFromConfig({ connectivityCheckDisabled: value })).toBe(true);
  });

  it.each([false, "false", "0", "no", "off", "", 1, null])("rejects disabled value %j", (value) => {
    expect(elasticsearchConnectivityCheckDisabledFromConfig({ connectivityCheckDisabled: value })).toBe(false);
  });

  it("normalizes a legacy string flag when an edited connection is saved", () => {
    const disabled = elasticsearchConnectivityCheckDisabledFromConfig({ connectivityCheckDisabled: " yes " });
    const saved = buildElasticsearchExternalConfig("direct", "", "", "", disabled);

    expect(saved).toEqual({ connectivityCheckDisabled: true });
    expect(elasticsearchConnectivityCheckDisabledFromConfig(saved)).toBe(true);
  });
});
