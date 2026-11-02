import type { DatabaseModelColumn, DatabaseModelShape, ModelScalarType } from "./modelShape";
import { camelCase, commentLines, pascalCase, safeIdentifier, snakeCase } from "./modelShape";

export type ModelFormatId = "typescript" | "zod" | "yup" | "joi" | "pydantic" | "python-dataclass" | "go-struct" | "rust-struct" | "kotlin" | "swift" | "dart" | "java" | "csharp" | "php" | "ruby";

export interface ModelRendererMeta {
  id: ModelFormatId;
  label: string;
  extension: string;
  render: (shape: DatabaseModelShape) => string;
}

export interface ModelGenerationOptions {
  includeHeaderComments?: boolean;
}

const scalar: Record<ModelScalarType, string> = {
  string: "string",
  integer: "number",
  number: "number",
  boolean: "boolean",
  date: "string",
  time: "string",
  datetime: "string",
  binary: "Uint8Array",
  json: "unknown",
  uuid: "string",
  unknown: "unknown",
};

function tsName(column: DatabaseModelColumn): string {
  return safeIdentifier(camelCase(column.name));
}
function className(shape: DatabaseModelShape): string {
  return safeIdentifier(pascalCase(shape.tableName), "Model");
}
function tsType(column: DatabaseModelColumn): string {
  return scalar[column.normalizedType] + (column.nullable ? " | null" : "");
}
function jsDoc(value: string | null | undefined): string[] {
  return commentLines(value, " * ");
}
function jsDocBlock(value: string | null | undefined): string[] {
  const lines = jsDoc(value);
  return lines.length ? ["/**", ...lines, " */"] : [];
}

function renderTypeScript(shape: DatabaseModelShape): string {
  const lines = [...jsDocBlock(shape.tableComment), `export interface ${className(shape)} {`];
  for (const column of shape.columns) lines.push(...jsDocBlock(column.comment).map((line) => `  ${line}`), `  ${tsName(column)}: ${tsType(column)};`);
  lines.push("}");
  return lines.join("\n");
}

function renderZod(shape: DatabaseModelShape): string {
  const lines = [`import { z } from "zod";`, "", `export const ${className(shape)}Schema = z.object({`];
  for (const column of shape.columns) {
    const base = { string: "z.string()", integer: "z.number().int()", number: "z.number()", boolean: "z.boolean()", date: "z.coerce.date()", time: "z.string()", datetime: "z.coerce.date()", binary: "z.instanceof(Uint8Array)", json: "z.unknown()", uuid: "z.string().uuid()", unknown: "z.unknown()" }[
      column.normalizedType
    ];
    lines.push(`  ${JSON.stringify(tsName(column))}: ${base}${column.nullable ? ".nullable()" : ""},`);
  }
  lines.push("});", "", `export type ${className(shape)} = z.infer<typeof ${className(shape)}Schema>;`);
  return lines.join("\n");
}

function renderYup(shape: DatabaseModelShape): string {
  const lines = [`import * as yup from "yup";`, "", `export const ${className(shape)}Schema = yup.object({`];
  for (const column of shape.columns) {
    const base = { string: "yup.string()", integer: "yup.number().integer()", number: "yup.number()", boolean: "yup.boolean()", date: "yup.date()", time: "yup.string()", datetime: "yup.date()", binary: "yup.mixed<Uint8Array>()", json: "yup.mixed()", uuid: "yup.string()", unknown: "yup.mixed()" }[
      column.normalizedType
    ];
    lines.push(`  ${JSON.stringify(tsName(column))}: ${base}${column.nullable ? ".nullable()" : ".required()"},`);
  }
  lines.push("});");
  return lines.join("\n");
}

function renderJoi(shape: DatabaseModelShape): string {
  const lines = [`import Joi from "joi";`, "", `export const ${className(shape)}Schema = Joi.object({`];
  for (const column of shape.columns) {
    const base = { string: "Joi.string()", integer: "Joi.number().integer()", number: "Joi.number()", boolean: "Joi.boolean()", date: "Joi.date()", time: "Joi.string()", datetime: "Joi.date()", binary: "Joi.binary()", json: "Joi.any()", uuid: "Joi.string().guid()", unknown: "Joi.any()" }[
      column.normalizedType
    ];
    lines.push(`  ${JSON.stringify(tsName(column))}: ${base}${column.nullable ? ".allow(null)" : ".required()"},`);
  }
  lines.push("});");
  return lines.join("\n");
}

function pythonType(column: DatabaseModelColumn): string {
  return { string: "str", integer: "int", number: "float", boolean: "bool", date: "date", time: "time", datetime: "datetime", binary: "bytes", json: "Any", uuid: "UUID", unknown: "Any" }[column.normalizedType];
}
function renderPython(shape: DatabaseModelShape, pydantic: boolean): string {
  const imports = pydantic
    ? ["from typing import Any, Optional", "from datetime import date, datetime, time", "from uuid import UUID", "from pydantic import BaseModel"]
    : ["from dataclasses import dataclass", "from typing import Any, Optional", "from datetime import date, datetime, time", "from uuid import UUID"];
  const lines = [...imports, "", ...(pydantic ? [] : ["@dataclass(kw_only=True)"]), `class ${className(shape)}(${pydantic ? "BaseModel" : "object"}):`];
  if (!shape.columns.length) lines.push("    pass");
  for (const column of shape.columns) {
    lines.push(...commentLines(column.comment, "    # ").map((line) => line), `    ${safeIdentifier(snakeCase(column.name))}: ${column.nullable ? `Optional[${pythonType(column)}]` : pythonType(column)}${column.nullable ? " = None" : ""}`);
  }
  return lines.join("\n");
}

function goType(column: DatabaseModelColumn): string {
  return { string: "string", integer: "int64", number: "float64", boolean: "bool", date: "time.Time", time: "time.Time", datetime: "time.Time", binary: "[]byte", json: "any", uuid: "string", unknown: "any" }[column.normalizedType];
}
function renderGo(shape: DatabaseModelShape): string {
  const lines = ["package models", "", ...(shape.columns.some((column) => ["date", "time", "datetime"].includes(column.normalizedType)) ? ['import "time"', ""] : []), `type ${className(shape)} struct {`];
  for (const column of shape.columns) lines.push(...commentLines(column.comment, "\t// "), `\t${pascalCase(column.name)} ${column.nullable ? "*" : ""}${goType(column)} \`json:"${column.name}"\``);
  lines.push("}");
  return lines.join("\n");
}

function renderRust(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "String", integer: "i64", number: "f64", boolean: "bool", date: "String", time: "String", datetime: "String", binary: "Vec<u8>", json: "serde_json::Value", uuid: "String", unknown: "serde_json::Value" };
  const lines = ["use serde::{Deserialize, Serialize};", "", "#[derive(Debug, Clone, Serialize, Deserialize)]", `pub struct ${className(shape)} {`];
  for (const column of shape.columns) lines.push(...commentLines(column.comment, "    /// "), `    #[serde(rename = ${JSON.stringify(column.name)})]`, `    pub ${safeIdentifier(snakeCase(column.name))}: ${column.nullable ? `Option<${map[column.normalizedType]}>` : map[column.normalizedType]},`);
  lines.push("}");
  return lines.join("\n");
}

function renderKotlin(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "String", integer: "Long", number: "Double", boolean: "Boolean", date: "String", time: "String", datetime: "String", binary: "ByteArray", json: "String", uuid: "String", unknown: "Any" };
  const lines = [`data class ${className(shape)}(`];
  shape.columns.forEach((column, index) => lines.push(`    val ${safeIdentifier(camelCase(column.name))}: ${map[column.normalizedType]}${column.nullable ? "?" : ""}${index === shape.columns.length - 1 ? "" : ","}`));
  lines.push(");");
  return lines.join("\n");
}

function renderSwift(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "String", integer: "Int", number: "Double", boolean: "Bool", date: "Date", time: "String", datetime: "Date", binary: "Data", json: "String", uuid: "UUID", unknown: "String" };
  const lines = ["import Foundation", "", `struct ${className(shape)}: Codable {`];
  for (const column of shape.columns) lines.push(`    let ${safeIdentifier(camelCase(column.name))}: ${map[column.normalizedType]}${column.nullable ? "?" : ""}`);
  lines.push("}");
  return lines.join("\n");
}

function renderDart(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "String", integer: "int", number: "double", boolean: "bool", date: "DateTime", time: "String", datetime: "DateTime", binary: "List<int>", json: "dynamic", uuid: "String", unknown: "dynamic" };
  const lines = [`class ${className(shape)} {`];
  for (const column of shape.columns) lines.push(`  final ${map[column.normalizedType]}${column.nullable ? "?" : ""} ${safeIdentifier(camelCase(column.name))};`);
  lines.push("", `  ${className(shape)}({`);
  for (const column of shape.columns) lines.push(`    required this.${safeIdentifier(camelCase(column.name))},`);
  lines.push("  });", "}");
  return lines.join("\n");
}

function renderJava(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "String", integer: "Long", number: "BigDecimal", boolean: "Boolean", date: "LocalDate", time: "LocalTime", datetime: "LocalDateTime", binary: "byte[]", json: "Object", uuid: "UUID", unknown: "Object" };
  const lines = ["import java.math.BigDecimal;", "import java.time.*;", "import java.util.UUID;", "", `public class ${className(shape)} {`];
  for (const column of shape.columns) {
    const name = safeIdentifier(camelCase(column.name));
    const type = map[column.normalizedType];
    lines.push(`    private ${type} ${name};`, `    public ${type} get${pascalCase(name)}() { return ${name}; }`, `    public void set${pascalCase(name)}(${type} value) { this.${name} = value; }`);
  }
  lines.push("}");
  return lines.join("\n");
}

function renderCsharp(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "string", integer: "long", number: "decimal", boolean: "bool", date: "DateOnly", time: "TimeOnly", datetime: "DateTime", binary: "byte[]", json: "JsonElement", uuid: "Guid", unknown: "object" };
  const lines = ["#nullable enable", "using System;", "using System.Text.Json;", "", `public sealed record ${className(shape)}(`];
  shape.columns.forEach((column, index) => lines.push(`    ${map[column.normalizedType]}${column.nullable ? "?" : ""} ${pascalCase(column.name)}${index === shape.columns.length - 1 ? "" : ","}`));
  lines.push(");");
  return lines.join("\n");
}

function renderPhp(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "string", integer: "int", number: "float", boolean: "bool", date: "string", time: "string", datetime: "DateTimeImmutable", binary: "string", json: "mixed", uuid: "string", unknown: "mixed" };
  const lines = ["<?php", "", `final class ${className(shape)}`, "{", "    public function __construct("];
  shape.columns.forEach((column, index) => lines.push(`        public ${column.nullable && map[column.normalizedType] !== "mixed" ? "?" : ""}${map[column.normalizedType]} $${safeIdentifier(camelCase(column.name))}${index === shape.columns.length - 1 ? "" : ","}`));
  lines.push("    ) {}", "}");
  return lines.join("\n");
}

function renderRuby(shape: DatabaseModelShape): string {
  const map: Record<ModelScalarType, string> = { string: "String", integer: "Integer", number: "Numeric", boolean: "TrueClass", date: "Date", time: "String", datetime: "Time", binary: "String", json: "Object", uuid: "String", unknown: "Object" };
  const lines = [`class ${className(shape)}`, `  attr_accessor ${shape.columns.map((column) => `:${safeIdentifier(snakeCase(column.name))}`).join(", ")}`, "", `  def initialize(`];
  lines.push(shape.columns.map((column) => `${safeIdentifier(snakeCase(column.name))}: nil`).join(", "), "  )");
  for (const column of shape.columns) lines.push(`    @${safeIdentifier(snakeCase(column.name))} = ${safeIdentifier(snakeCase(column.name))} # ${map[column.normalizedType]}`);
  lines.push("  end", "end");
  return lines.join("\n");
}

export const MODEL_RENDERERS: readonly ModelRendererMeta[] = [
  { id: "typescript", label: "TypeScript", extension: "ts", render: renderTypeScript },
  { id: "zod", label: "Zod", extension: "ts", render: renderZod },
  { id: "yup", label: "Yup", extension: "ts", render: renderYup },
  { id: "joi", label: "Joi", extension: "ts", render: renderJoi },
  { id: "pydantic", label: "Pydantic", extension: "py", render: (shape) => renderPython(shape, true) },
  { id: "python-dataclass", label: "Python dataclass", extension: "py", render: (shape) => renderPython(shape, false) },
  { id: "go-struct", label: "Go struct", extension: "go", render: renderGo },
  { id: "rust-struct", label: "Rust struct", extension: "rs", render: renderRust },
  { id: "kotlin", label: "Kotlin data class", extension: "kt", render: renderKotlin },
  { id: "swift", label: "Swift struct", extension: "swift", render: renderSwift },
  { id: "dart", label: "Dart class", extension: "dart", render: renderDart },
  { id: "java", label: "Java POJO", extension: "java", render: renderJava },
  { id: "csharp", label: "C# record", extension: "cs", render: renderCsharp },
  { id: "php", label: "PHP class", extension: "php", render: renderPhp },
  { id: "ruby", label: "Ruby class", extension: "rb", render: renderRuby },
];

export function modelRenderer(id: ModelFormatId): ModelRendererMeta | undefined {
  return MODEL_RENDERERS.find((renderer) => renderer.id === id);
}

export function generateModel(shape: DatabaseModelShape, id: ModelFormatId, options: ModelGenerationOptions = {}): string {
  const renderer = modelRenderer(id);
  if (!renderer) throw new Error("Unknown model format");
  const prefix = ["python-dataclass", "pydantic", "ruby"].includes(id) ? "# " : "// ";
  const comments = [
    shape.tableComment,
    ...shape.columns.map((column) => `${column.name}: ${column.originalType}${column.primaryKey ? "; PRIMARY KEY" : ""}${column.nullable ? "; NULL" : "; NOT NULL"}${column.defaultValue ? `; DEFAULT ${column.defaultValue}` : ""}${column.comment ? `; ${column.comment}` : ""}`),
  ]
    .filter(Boolean)
    .flatMap((value) => commentLines(value, prefix))
    .join("\n");
  const used = new Set<string>();
  const named = {
    ...shape,
    columns: shape.columns.map((column) => {
      const base = safeIdentifier(camelCase(column.name));
      let name = base;
      let suffix = 2;
      while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`;
      used.add(name.toLowerCase());
      return { ...column, name };
    }),
  };
  let code = renderer.render(named);
  // Go and Rust must retain the original database field name in serialization tags.
  if (id === "go-struct" || id === "rust-struct") {
    named.columns.forEach((column, index) => {
      const original = shape.columns[index]!.name;
      if (id === "go-struct") code = code.replace(`json:"${column.name}"`, `json:"${original.replace(/["\\\x00-\x1f`]/g, "_")}"`);
      else code = code.replace(`rename = "${column.name}"`, `rename = ${JSON.stringify(original)}`);
    });
  }
  if (!options.includeHeaderComments) return `${code}\n`;
  return id === "php" ? code.replace("<?php", `<?php\n${comments}`) + "\n" : `${comments}\n\n${code}\n`;
}
