import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ANNOTATION_FILE_KEYS, COLUMN_ANNOTATION_KEYS, GROUP_ANNOTATION_KEYS, PROJECT_ANNOTATION_KEYS, TABLE_ANNOTATION_KEYS } from "../types";

// The Rust structs carry deny_unknown_fields, so any property TypeScript adds
// that Rust does not declare turns every save into a deserialization error at
// runtime. vue-tsc cannot see across the language boundary, so this reads the
// Rust source and compares the field sets directly.
const rustSource = readFileSync(path.resolve(__dirname, "../../../../../crates/dbx-core/src/docs/annotations.rs"), "utf8");

function rustFields(structName: string): string[] {
  const start = rustSource.indexOf(`pub struct ${structName} {`);
  expect(start, `struct ${structName} not found in annotations.rs`).toBeGreaterThan(-1);
  const body = rustSource.slice(start, rustSource.indexOf("\n}", start));
  return [...body.matchAll(/^\s{4}pub ([a-z_]+):/gm)].map((match) => toCamel(match[1])).sort();
}

function toCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

describe("annotation types match the Rust structs", () => {
  it.each([
    ["AnnotationFile", ANNOTATION_FILE_KEYS],
    ["ProjectAnnotation", PROJECT_ANNOTATION_KEYS],
    ["GroupAnnotation", GROUP_ANNOTATION_KEYS],
    ["TableAnnotation", TABLE_ANNOTATION_KEYS],
    ["ColumnAnnotation", COLUMN_ANNOTATION_KEYS],
  ])("%s", (structName, witness) => {
    // Rust source on one side, the TS interface's own keys on the other —
    // so this fails whichever side drifts. Comparing Rust against a hardcoded
    // list would only ever catch the Rust side.
    expect(rustFields(structName as string)).toEqual(Object.keys(witness).sort());
  });
});
