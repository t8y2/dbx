import { describe, expect, it } from "vitest";
import { applyParsedConnectionUrl, parseConnectionUrl } from "@/lib/connection/connectionUrl";
import type { ConnectionConfig } from "@/types/database";

describe("VictoriaMetrics connection URL", () => {
  it("parses single-node HTTP URLs with Basic Auth", () => {
    expect(parseConnectionUrl("http://vm_user:secret@vm.example.com:8428/prometheus", "victoriametrics")).toMatchObject({
      dbType: "victoriametrics",
      host: "vm.example.com",
      port: 8428,
      username: "vm_user",
      password: "secret",
      database: "metrics",
      apiPath: "/prometheus",
      ssl: false,
    });
  });

  it("preserves cluster tenant API paths in external config", () => {
    const parsed = parseConnectionUrl("https://vm.example.com/select/42/prometheus", "victoriametrics");
    const config = applyParsedConnectionUrl(
      {
        db_type: "victoriametrics",
        name: "VictoriaMetrics",
        host: "",
        port: 8428,
        username: "",
        password: "",
        ssl: false,
        external_config: { lookback: "7d" },
      } as Omit<ConnectionConfig, "id">,
      parsed,
    );

    expect(config.ssl).toBe(true);
    expect(config.external_config).toEqual({ lookback: "7d", apiPath: "/select/42/prometheus" });
  });
});
