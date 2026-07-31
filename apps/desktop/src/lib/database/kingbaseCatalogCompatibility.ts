type KingbaseCatalogObjectKind = "relation" | "function";

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "").toUpperCase();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String((error as { message?: unknown }).message ?? "");
  return String(error);
}

function referencesCatalogObject(message: string, names: readonly string[]): boolean {
  const normalized = message.toLowerCase();
  return names.some((name) => {
    const lowerName = name.toLowerCase();
    const shortName = lowerName.slice(lowerName.lastIndexOf(".") + 1);
    return normalized.includes(lowerName) || normalized.includes(shortName);
  });
}

function isMissingKingbaseCatalogObject(error: unknown, kind: KingbaseCatalogObjectKind, names: readonly string[]): boolean {
  const message = errorMessage(error);
  if (!referencesCatalogObject(message, names)) return false;

  const expectedCode = kind === "relation" ? "42P01" : "42883";
  const directCode = errorCode(error);
  if (directCode) return directCode === expectedCode;

  const messageCode = message.match(/\b(?:SQLSTATE\s*[:=]?\s*)?(42P01|42883)\b/i)?.[1]?.toUpperCase();
  if (messageCode) return messageCode === expectedCode;

  const missingPattern = kind === "relation" ? /(?:relation|table)[\s\S]*?(?:does not exist|not found|undefined)|(?:does not exist|not found|undefined)[\s\S]*?(?:relation|table)/i : /function[\s\S]*?(?:does not exist|not found|undefined)|(?:does not exist|not found|undefined)[\s\S]*?function/i;
  return missingPattern.test(message);
}

export function isMissingKingbaseSysRelation(error: unknown, names: readonly string[]): boolean {
  return isMissingKingbaseCatalogObject(error, "relation", names);
}

export function isMissingKingbaseSysFunction(error: unknown, names: readonly string[]): boolean {
  return isMissingKingbaseCatalogObject(error, "function", names);
}
