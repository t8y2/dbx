import type { SchemaDiffObject } from "@/lib/schema/schemaDiff";

function readSqlIdentifier(value: string): string | null {
  const input = value.trimStart();
  const opening = input[0];
  const closing = opening === "[" ? "]" : opening;

  if (opening === "`" || opening === '"' || opening === "[") {
    let identifier = "";
    for (let index = 1; index < input.length; index++) {
      if (input[index] !== closing) {
        identifier += input[index];
        continue;
      }
      if (input[index + 1] === closing) {
        identifier += closing;
        index++;
        continue;
      }
      return identifier;
    }
    return null;
  }

  return input.match(/^([A-Za-z_][A-Za-z0-9_$#@]*)/)?.[1] ?? null;
}

function identifierAfterKeyword(line: string, keyword: RegExp): string | null {
  const trimmed = line.trimStart();
  const match = trimmed.match(keyword);
  return match ? readSqlIdentifier(trimmed.slice(match[0].length)) : null;
}

function lineMatchesObject(line: string, object: SchemaDiffObject, objectName: string): boolean {
  const trimmed = line.trimStart();

  switch (object.objectKind) {
    case "column":
      return readSqlIdentifier(trimmed) === objectName;
    case "index":
      if (objectName.toUpperCase() === "PRIMARY" && /^PRIMARY\s+KEY\b/i.test(trimmed)) return true;
      return identifierAfterKeyword(trimmed, /^(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?(?:KEY|INDEX)\s+/i) === objectName || identifierAfterKeyword(trimmed, /^CREATE\s+(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?INDEX\s+/i) === objectName;
    case "foreignKey":
      return identifierAfterKeyword(trimmed, /^CONSTRAINT\s+/i) === objectName;
    case "tableOption":
      return /^\)\s*/.test(trimmed) || /\b(?:ENGINE|CHARSET|COLLATE|COMMENT)\s*=/i.test(trimmed);
    case "table":
    case "view":
      return /^CREATE\s+/i.test(trimmed);
    default:
      return trimmed.includes(objectName);
  }
}

export function findSchemaDiffDdlLineNumber(ddl: string, object: SchemaDiffObject, side: "source" | "target"): number | null {
  if (!ddl) return null;
  const objectName = (side === "source" ? object.sourceName : object.targetName) ?? object.name;
  const lines = ddl.replace(/\r\n?/g, "\n").split("\n");
  const index = lines.findIndex((line) => lineMatchesObject(line, object, objectName));
  return index >= 0 ? index + 1 : null;
}
