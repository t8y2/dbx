import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { connectionBadge, sidebarTreeIconSize } from "@/lib/sidebar/connectionBadge";
import { databaseIconAssetName, databaseIconAssetPath, databaseIconAssets } from "@/lib/database/databaseIconAssets";
import type { ConnectionConfig } from "@/types/database";

const connection = (db_type: string, driver_profile?: string) => ({ db_type, driver_profile }) as ConnectionConfig;
const publicDir = path.resolve("apps/desktop/public");
const manifest = JSON.parse(readFileSync(path.resolve("crates/dbx-core/assets/database-drivers.manifest.json"), "utf8")) as {
  drivers: Array<{ dbType: string; driverProfiles?: Array<{ profile: string }> }>;
};

describe("sidebar connection badges", () => {
  it("covers every native driver and profile with a resolvable mark and fixed slot size", () => {
    for (const driver of manifest.drivers.filter((entry) => entry.dbType !== "plugin")) {
      for (const profile of [undefined, ...(driver.driverProfiles ?? []).map((entry) => entry.profile)]) {
        const config = connection(driver.dbType, profile);
        const badge = connectionBadge(config);
        expect(badge, `${driver.dbType}/${profile}`).toBeDefined();
        if (badge?.src) {
          expect(existsSync(path.join(publicDir, badge.src)), `${driver.dbType}/${profile}: ${badge.src}`).toBe(true);
        } else {
          expect(badge?.asset, `${driver.dbType}/${profile}`).toBe("generic");
        }
        expect(sidebarTreeIconSize("connection", config, "badge")).toBe(16);
      }
    }
  });

  it("shares valid original assets with the general database icon renderer", () => {
    for (const type of Object.keys(databaseIconAssets)) {
      const src = databaseIconAssetPath(type);
      expect(src, type).toBeTruthy();
      expect(existsSync(path.join(publicDir, src!)), `${type}: ${src}`).toBe(true);
    }
    expect(databaseIconAssetName("SQLite-Worker")).toBe("sqlite");
    expect(databaseIconAssetName("oracle-10g")).toBe("oracle");
    expect(databaseIconAssetName("toString")).toBeUndefined();
  });

  it("preserves approved colors and resolves provider identities before native fallbacks", () => {
    expect(connectionBadge(connection("redis"))).toMatchObject({ asset: "redis", color: "#983d48", basic: false });
    expect(connectionBadge(connection("mysql"))).toMatchObject({ asset: "mysql", color: "#28d43b", basic: false });
    expect(connectionBadge(connection("mysql", "mariadb"))?.asset).toBe("mariadb");
    expect(connectionBadge(connection("mq", "kafka"))?.asset).toBe("kafka");
    expect(connectionBadge(connection("mq", "rabbitmq"))?.asset).toBe("rabbitmq");
    expect(connectionBadge(connection("oracle", "future-oci-profile"))?.asset).toBe("oracle");
    expect(connectionBadge(connection("nebula", "nebula-v3"))?.src).toBe("/icons/database/sidebar/nebula.svg");
  });

  it("uses original artwork for basic adaptation and a safe glyph for unknown native types", () => {
    expect(connectionBadge(connection("kyuubi"))).toMatchObject({ src: "/icons/database/kyuubi.png", basic: true });
    expect(connectionBadge(connection("future-database"))).toMatchObject({ asset: "generic", color: "#315f9b", basic: true });
    expect(sidebarTreeIconSize("connection", connection("future-database"), "badge")).toBe(16);
    expect(sidebarTreeIconSize("connection", connection("mysql"), "classic")).toBe(14);
    expect(connectionBadge(connection("future-database"))?.src).toBeUndefined();
    expect(connectionBadge(connection("plugin", "mysql"))).toBeUndefined();
    expect(connectionBadge()).toBeUndefined();
    expect(sidebarTreeIconSize("connection", connection("plugin"), "badge")).toBe(14);
  });
});
