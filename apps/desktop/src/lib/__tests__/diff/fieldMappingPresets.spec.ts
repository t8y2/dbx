import { describe, expect, it } from "vitest";
import { findPreset } from "@/lib/fieldMappingPresets";

describe("fieldMappingPresets", () => {
  it("contains sqlserver-to-postgresql preset", () => {
    const preset = findPreset("sqlserver", "postgresql");
    expect(preset).toBeDefined();
    expect(preset?.id).toBe("sqlserver-to-postgresql");

    const uuidMapping = preset?.mappings.find((m) => m.sourceType === "UNIQUEIDENTIFIER");
    expect(uuidMapping).toBeDefined();
    expect(uuidMapping?.targetType).toBe("UUID");
    expect(uuidMapping?.paramStrategy).toBe("strip");
  });

  it("supports postgres alias for postgresql", () => {
    const preset = findPreset("sqlserver", "postgres");
    expect(preset).toBeDefined();
    expect(preset?.id).toBe("sqlserver-to-postgresql");
  });

  it("supports reverse match postgresql to sqlserver", () => {
    const preset = findPreset("postgresql", "sqlserver");
    expect(preset).toBeDefined();
    expect(preset?.id).toBe("sqlserver-to-postgresql-reverse");

    const uuidMapping = preset?.mappings.find((m) => m.sourceType === "UUID");
    expect(uuidMapping).toBeDefined();
    expect(uuidMapping?.targetType).toBe("UNIQUEIDENTIFIER");
  });

  it("supports reverse match postgres to sqlserver", () => {
    const preset = findPreset("postgres", "sqlserver");
    expect(preset).toBeDefined();
    expect(preset?.id).toBe("sqlserver-to-postgresql-reverse");
  });
});
