import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");

describe("SidebarTreeRuntimeHost database backup menu", () => {
  it("uses the database backup support matrix independently from full-database export", () => {
    expect(source).toMatch(/const canOpenScheduledBackups = computed\(\(\) => \{[\s\S]*supportsScheduledDatabaseBackup\(rawDatabaseType\(\)\)/);
    expect(source).toMatch(/if \(canOpenScheduledBackups\.value\) \{[\s\S]*action: openScheduledBackups/);
  });
});
