import { describe, expect, it } from "vitest";
import { findSchemaDiffDdlLineNumber } from "@/lib/schema/schemaDiffDdlLocate";
import type { SchemaDiffObject } from "@/lib/schema/schemaDiff";

const field: SchemaDiffObject = {
  id: "col-agents-context_window",
  operationType: "modify",
  objectKind: "column",
  name: "context_window",
  selected: true,
  parentId: "table-agents",
};

describe("schema diff DDL location", () => {
  it("finds a moved field independently on both DDL sides", () => {
    const source = ["CREATE TABLE `agents` (", "  `id` bigint NOT NULL,", "  `context_window` int NOT NULL", ");"].join("\n");
    const target = ["CREATE TABLE `agents` (", "  `context_window` int DEFAULT NULL,", "  `id` bigint NOT NULL", ");"].join("\n");

    expect(findSchemaDiffDdlLineNumber(source, field, "source")).toBe(3);
    expect(findSchemaDiffDdlLineNumber(target, field, "target")).toBe(2);
  });

  it("returns null on the side where a created field does not exist", () => {
    const createdField = { ...field, operationType: "create" as const, name: "next_step_prompt", sourceName: "next_step_prompt", targetName: undefined };
    const source = ["CREATE TABLE `agents` (", "  `next_step_prompt` longtext", ");"].join("\n");
    const target = ["CREATE TABLE `agents` (", "  `id` bigint NOT NULL", ");"].join("\n");

    expect(findSchemaDiffDdlLineNumber(source, createdField, "source")).toBe(2);
    expect(findSchemaDiffDdlLineNumber(target, createdField, "target")).toBeNull();
  });
});
