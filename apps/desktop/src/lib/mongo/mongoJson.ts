/** Exact Int64/Decimal values must use canonical Extended JSON string wrappers. */
export function parseMongoJson(text: string): unknown {
  if (text.length > 2 * 1024 * 1024) throw new Error("JSON exceeds 2 MiB");
  return JSON.parse(text, (_key, value) => {
    if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error("Unsafe JSON number; use canonical $numberLong/$numberDecimal string wrappers");
    return value;
  });
}
