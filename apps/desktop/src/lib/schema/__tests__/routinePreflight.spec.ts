import { describe, expect, it, vi } from "vitest";
import { preflightRoutineDeployment } from "../routinePreflight";
import type { FunctionInfo } from "@/types/database";
import type { FunctionDiff } from "../schemaDiff";

const source: FunctionInfo = { name: "P", function_type: "PROCEDURE", data_type: "", arguments: "", schema: "SRC", status: "VALID", definition: "CREATE PROCEDURE SRC.P AS BEGIN NULL; END;", dependencies: [] };
const target = { ...source, schema: "DST" };
const diff: FunctionDiff = { name: "P", type: "modified", source, target };
const valid = [{ name: "P", routineType: "PROCEDURE", success: true, message: "verified" }];

describe("routine deployment preflight", () => {
  it("allows the unchanged snapshot", async () => {
    await expect(
      preflightRoutineDeployment(
        [diff],
        async () => [source],
        async () => valid,
      ),
    ).resolves.toBeUndefined();
  });
  it.each([[], [{ ...source, definition: "changed" }], [{ ...source, status: "INVALID" }], [{ ...source, schema: "OTHER" }], [{ ...source, dependencies: ['"SRC"."Q"'] }]].map((current) => ({ current })))("blocks source drift before target validation", async ({ current }) => {
    const validate = vi.fn(async (_input: FunctionDiff[]) => valid);
    await expect(preflightRoutineDeployment([diff], async () => current, validate)).rejects.toThrow("source changed");
    expect(validate).not.toHaveBeenCalled();
  });
  it("blocks a newly appeared source object for a removal", async () => {
    await expect(
      preflightRoutineDeployment(
        [{ ...diff, type: "removed", source: undefined }],
        async () => [source],
        async () => valid,
      ),
    ).rejects.toThrow("source changed");
  });
  it("blocks target drift and never sends the DDL", async () => {
    const execute = vi.fn();
    await expect(
      (async () => {
        await preflightRoutineDeployment(
          [diff],
          async () => [source],
          async () => {
            throw new Error("target source changed");
          },
        );
        execute();
      })(),
    ).rejects.toThrow("target source changed");
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects missing or failed target validation", async () => {
    await expect(
      preflightRoutineDeployment(
        [diff],
        async () => [source],
        async () => [],
      ),
    ).rejects.toThrow("target preflight failed");
    await expect(
      preflightRoutineDeployment(
        [diff],
        async () => [source],
        async () => [{ ...valid[0]!, success: false }],
      ),
    ).rejects.toThrow("target preflight failed");
  });
  it("checks the deployed target snapshot before rollback", async () => {
    const load = vi.fn();
    const validate = vi.fn(async (_input: FunctionDiff[]) => valid);
    await preflightRoutineDeployment([diff], load, validate, true, "DST");
    expect(load).not.toHaveBeenCalled();
    expect(validate.mock.calls[0]![0]![0]).toMatchObject({ source: target, target: { ...source, schema: "DST" } });
  });
});
