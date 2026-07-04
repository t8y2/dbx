export function expandNestedJsonStringsForCopy(value: unknown): unknown {
  if (typeof value === "string") {
    return parseNestedJsonString(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map(expandNestedJsonStringsForCopy);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandNestedJsonStringsForCopy(item)]));
  }

  return value;
}

function parseNestedJsonString(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return undefined;

  try {
    return expandNestedJsonStringsForCopy(JSON.parse(trimmed));
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
