import { describe, expect, it } from "vitest";
import { connectionDisplayUrlScheme, connectionUrlPlaceholder } from "@/lib/connection/connectionPresentation";
import { applyParsedConnectionUrl, parseConnectionUrl } from "@/lib/connection/connectionUrl";
import { connectionCanChooseVisibleDatabases } from "@/lib/connection/connectionVisibleDatabases";
import type { ConnectionConfig } from "@/types/database";

describe("DynamoDB connection presentation", () => {
  it("uses a DynamoDB endpoint URL as the connection placeholder", () => {
    expect(connectionUrlPlaceholder("dynamodb")).toBe("https://dynamodb.us-east-1.amazonaws.com");
    expect(connectionDisplayUrlScheme({ db_type: "dynamodb", ssl: true })).toBe("https");
    expect(connectionDisplayUrlScheme({ db_type: "dynamodb", ssl: false })).toBe("http");
  });

  it("parses an HTTPS endpoint while DynamoDB is selected", () => {
    expect(parseConnectionUrl("https://dynamodb.eu-west-1.amazonaws.com", "dynamodb")).toMatchObject({
      dbType: "dynamodb",
      driverProfile: "dynamodb",
      host: "dynamodb.eu-west-1.amazonaws.com",
      port: 443,
      database: "eu-west-1",
      ssl: true,
    });
  });

  it("preserves the selected region for a custom endpoint URL", () => {
    const parsed = parseConnectionUrl("http://127.0.0.1:8000", "dynamodb");
    const config = applyParsedConnectionUrl(
      {
        db_type: "dynamodb",
        driver_profile: "dynamodb",
        name: "DynamoDB Local",
        host: "127.0.0.1",
        port: 8000,
        username: "local",
        password: "local",
        database: "ap-southeast-1",
      } as Omit<ConnectionConfig, "id">,
      parsed,
    );

    expect(config.database).toBe("ap-southeast-1");
    expect(config.username).toBe("local");
    expect(config.password).toBe("local");
  });

  it("does not offer database visibility selection", () => {
    expect(connectionCanChooseVisibleDatabases({ db_type: "dynamodb" })).toBe(false);
  });
});
