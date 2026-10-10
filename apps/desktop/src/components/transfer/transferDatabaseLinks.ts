import type { TransferDatabaseLinkConfig, TransferDatabaseLinkCredential } from "@/lib/backend/api";
import type { OracleDatabaseLink } from "@/lib/database/oracleDatabaseLinks";

export function transferDatabaseLinkKey(objectType: TransferDatabaseLinkConfig["objectType"], name: string): string {
  return JSON.stringify([objectType, name]);
}

export function transferDatabaseLinkConfig(link: OracleDatabaseLink): TransferDatabaseLinkConfig {
  return { objectType: link.owner === "PUBLIC" || link.owner === "__public" ? "PUBLIC_DB_LINK" : "DB_LINK", name: link.name, sourceOwner: link.owner, targetName: link.name, targetScope: "", authentication: "fixedUser", username: link.username, host: link.host, credentialAvailable: false };
}

/** Saved tasks retain only public fields and always require fresh credentials. */
export function savedTransferDatabaseLinks(raw: unknown): TransferDatabaseLinkConfig[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || !["DB_LINK", "PUBLIC_DB_LINK"].includes(value.objectType) || typeof value.name !== "string" || typeof value.sourceOwner !== "string" || value.authentication !== "fixedUser") return [];
    const text = (key: string) => (typeof value[key] === "string" ? value[key] : "");
    return [
      {
        objectType: value.objectType as TransferDatabaseLinkConfig["objectType"],
        name: value.name,
        sourceOwner: value.sourceOwner,
        targetName: text("targetName"),
        targetScope: ["private", "public", "tenant"].includes(value.targetScope) ? (value.targetScope as TransferDatabaseLinkConfig["targetScope"]) : "",
        authentication: "fixedUser" as const,
        username: text("username"),
        host: text("host"),
        protocol: value.protocol === "OB" || value.protocol === "OCI" ? value.protocol : undefined,
        tenant: text("tenant"),
        cluster: text("cluster"),
        credentialAvailable: false,
      },
    ];
  });
}

export function transferDatabaseLinkPayload(configs: TransferDatabaseLinkConfig[], passwords: Record<string, string>): { databaseLinks: TransferDatabaseLinkConfig[]; credentials: TransferDatabaseLinkCredential[] } {
  const publicConfigs = savedTransferDatabaseLinks(configs);
  return {
    databaseLinks: publicConfigs.map((config) => ({ ...config, credentialAvailable: Boolean(passwords[transferDatabaseLinkKey(config.objectType, config.name)]) })),
    credentials: publicConfigs.flatMap((config) => {
      const password = passwords[transferDatabaseLinkKey(config.objectType, config.name)];
      return password ? [{ objectType: config.objectType, name: config.name, password }] : [];
    }),
  };
}

export function clearTransferDatabaseLinkCredentials(credentials: TransferDatabaseLinkCredential[]): void {
  for (const credential of credentials) credential.password = "";
  credentials.length = 0;
}
