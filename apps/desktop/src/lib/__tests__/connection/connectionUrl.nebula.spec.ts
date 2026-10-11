import { describe, expect, it } from "vitest";
import { connectionUrlPlaceholder } from "@/lib/connection/connectionPresentation";
import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

describe("NebulaGraph connection URLs", () => {
  it("parses graphd connection details and an optional space", () => {
    expect(parseConnectionUrl("nebula://root:secret@graphd.example.com:9669/demo")).toMatchObject({
      dbType: "nebula",
      driverProfile: "nebula",
      host: "graphd.example.com",
      port: 9669,
      username: "root",
      password: "secret",
      database: "demo",
    });
  });

  it("shows a NebulaGraph-specific placeholder", () => {
    expect(connectionUrlPlaceholder("nebula")).toBe("nebula://root:password@graphd:9669/space");
  });
});
