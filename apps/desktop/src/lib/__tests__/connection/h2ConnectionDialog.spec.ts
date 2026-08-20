import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../../../components/connection/ConnectionDialog.vue", import.meta.url), "utf8");
const categoriesSource = readFileSync(new URL("../../connection/driver-category-definitions.ts", import.meta.url), "utf8");

describe("H2 connection dialog driver profiles", () => {
  it("offers auto, bundled compatibility ranges, and a custom JAR fallback", () => {
    expect(dialogSource).toContain("@click=\"switchH2DriverProfile('h2')\"");
    expect(dialogSource).toContain("@click=\"switchH2DriverProfile('h2-v1')\"");
    expect(dialogSource).toContain("@click=\"switchH2DriverProfile('h2-v2')\"");
    expect(dialogSource).toContain("@click=\"switchH2DriverProfile('h2-v3')\"");
    expect(dialogSource).toContain("@click=\"switchH2DriverProfile('h2-custom')\"");
    expect(dialogSource).toContain(">Custom JAR</Button>");
  });

  it("reuses the JDBC classpath picker only for the custom profile", () => {
    expect(dialogSource).toContain('const isH2CustomDriver = computed(() => form.value.db_type === "h2" && form.value.driver_profile === "h2-custom");');
    expect(dialogSource).toContain('<template v-if="isH2CustomDriver">');
    expect(dialogSource).toContain('v-model="jdbcDriverPathsInput"');
    expect(dialogSource).toContain('@click="browseJdbcDriverPaths"');
    expect(dialogSource).toContain('placeholder="org.h2.Driver"');
  });

  it("defaults the custom class and clears stale classpath data for bundled profiles", () => {
    const switchBlock = dialogSource.match(/function switchH2DriverProfile[\s\S]*?\n\}/)?.[0] ?? "";
    expect(switchBlock).toContain('form.value.jdbc_driver_class = form.value.jdbc_driver_class?.trim() || "org.h2.Driver";');
    expect(switchBlock).toContain("form.value.jdbc_driver_paths = [];");
    expect(switchBlock).toContain('jdbcDriverPathsInput.value = "";');

    const submitBlock = dialogSource.match(/if \(config\.db_type === "h2"\) \{[\s\S]*?const h2Mode/)?.[0] ?? "";
    expect(submitBlock).toContain('config.driver_profile === "h2-custom"');
    expect(submitBlock).toContain("config.jdbc_driver_paths = parsedJdbcDriverPaths();");
    expect(submitBlock).toContain("config.jdbc_driver_paths = [];");
  });

  it("keeps legacy profile hydration without exposing a second H2 catalog entry", () => {
    expect(dialogSource).toContain('"h2-legacy": { type: "h2"');
    expect(categoriesSource).toContain('h2: "lightweight"');
    expect(categoriesSource).not.toContain('"h2-legacy": "lightweight"');
  });
});
