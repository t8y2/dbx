import { describe, expect, it } from "vitest";
import { JDBCX_JDBC_DRIVER_CLASS } from "@/lib/database/jdbcxBuiltinDriver";
import { parseDbeaverConnections } from "@/lib/imports/dbeaverImport";

describe("JDBCX connection import", () => {
  it("imports JDBCX connections with the JDBCX profile", async () => {
    const dataSources = JSON.stringify({
      connections: {
        "jdbcx-1": {
          id: "jdbcx-1",
          name: "federated-query",
          provider: "generic",
          driver: "jdbcx",
          configuration: {
            url: "jdbcx:script:mysql://db.example.com:3306/app",
            user: "analyst",
          },
        },
      },
    });
    const payload = JSON.stringify({ format: "dbeaver-import", dataSources });

    const [connection] = await parseDbeaverConnections(payload);

    expect(connection?.db_type).toBe("jdbc");
    expect(connection?.driver_profile).toBe("jdbcx");
    expect(connection?.driver_label).toBe("JDBCX");
    expect(connection?.connection_string).toBe("jdbcx:script:mysql://db.example.com:3306/app");
    expect(connection?.jdbc_driver_class).toBe(JDBCX_JDBC_DRIVER_CLASS);
  });

  it("prioritizes the jdbcx URL scheme for custom driver IDs", async () => {
    const dataSources = JSON.stringify({
      connections: {
        "jdbcx-custom": {
          id: "jdbcx-custom",
          name: "custom-jdbcx",
          provider: "generic",
          driver: "custom-mysql-wrapper",
          configuration: {
            url: "jdbcx:mysql://db.example.com:3306/app",
          },
        },
      },
    });

    const [connection] = await parseDbeaverConnections(JSON.stringify({ format: "dbeaver-import", dataSources }));

    expect(connection?.db_type).toBe("jdbc");
    expect(connection?.driver_profile).toBe("jdbcx");
    expect(connection?.driver_label).toBe("JDBCX");
    expect(connection?.jdbc_driver_class).toBe(JDBCX_JDBC_DRIVER_CLASS);
  });
});
