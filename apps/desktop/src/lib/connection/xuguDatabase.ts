import { parseConnectionUrl } from "@/lib/connection/connectionUrl";

function splitXuguDsnParts(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      current += character;
      if (inQuotes && value[index + 1] === "'") {
        current += value[index + 1];
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (character === ";" && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }

  parts.push(current);
  return parts;
}

function xuguDatabaseFromDsn(value: string): string | undefined {
  let database: string | undefined;
  for (const part of splitXuguDsnParts(value)) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim().toLowerCase() !== "db") continue;

    let candidate = part.slice(separator + 1).trim();
    if (candidate.startsWith("'") && candidate.endsWith("'")) {
      candidate = candidate.slice(1, -1).replaceAll("''", "'");
    }
    database = candidate.trim() || undefined;
  }
  return database;
}

export function xuguDatabaseFromConnectionString(connectionString: string | undefined): string | undefined {
  const value = connectionString?.trim();
  if (!value) return undefined;

  if (/^(?:ip|ips)\s*=/i.test(value)) {
    return xuguDatabaseFromDsn(value);
  }

  try {
    const parsed = parseConnectionUrl(value, "xugu");
    return parsed.dbType === "xugu" ? parsed.database?.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

export function hasXuguConnectionDatabase(database: string | undefined, connectionString: string | undefined): boolean {
  return !!database?.trim() || !!xuguDatabaseFromConnectionString(connectionString);
}
