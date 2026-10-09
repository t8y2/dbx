import { describe, expect, it } from "vitest";
import { clearTransferDatabaseLinkCredentials, savedTransferDatabaseLinks, transferDatabaseLinkConfig, transferDatabaseLinkKey, transferDatabaseLinkPayload } from "../transferDatabaseLinks";

describe("database link transfer configuration", () => {
  const link = { owner: "SOURCE", name: "L.DOMAIN", username: "REMOTE", host: "connect-string", created: "" };

  it("keeps link domains and public identity without assuming target visibility", () => {
    expect(transferDatabaseLinkConfig(link)).toMatchObject({ objectType: "DB_LINK", name: "L.DOMAIN", targetScope: "", credentialAvailable: false });
    expect(transferDatabaseLinkConfig({ ...link, owner: "PUBLIC" })).toMatchObject({ objectType: "PUBLIC_DB_LINK", sourceOwner: "PUBLIC", targetScope: "" });
    expect(transferDatabaseLinkKey("DB_LINK", link.name)).not.toBe(transferDatabaseLinkKey("PUBLIC_DB_LINK", link.name));
  });

  it("keeps passwords out of public previews and strips them from saved configuration", () => {
    const config = { ...transferDatabaseLinkConfig(link), targetScope: "private" as const, password: "test-secret", credentials: { password: "nested-secret" }, credentialAvailable: true };
    const saved = savedTransferDatabaseLinks([config]);
    expect(JSON.stringify(saved)).not.toContain("secret");
    expect(saved[0]?.credentialAvailable).toBe(false);
    const payload = transferDatabaseLinkPayload(saved, { [transferDatabaseLinkKey("DB_LINK", link.name)]: "test-secret" });
    expect(payload.databaseLinks[0]?.credentialAvailable).toBe(true);
    expect(JSON.stringify(payload.databaseLinks)).not.toContain("test-secret");
    expect(payload.credentials).toEqual([{ objectType: "DB_LINK", name: link.name, password: "test-secret" }]);
    clearTransferDatabaseLinkCredentials(payload.credentials);
    expect(payload.credentials).toEqual([]);
  });

  it("requires new credentials after task restoration and never converts unsupported authentication", () => {
    const config = transferDatabaseLinkConfig(link);
    expect(transferDatabaseLinkPayload([config], {}).databaseLinks[0]?.credentialAvailable).toBe(false);
    expect(savedTransferDatabaseLinks([{ ...config, authentication: "currentUser" }])).toEqual([]);
  });
});
