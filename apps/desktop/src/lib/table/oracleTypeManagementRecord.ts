/** SQLite JSON storage and Rust serializers may reorder object properties, but
 * recovery definitions, baselines and ordered step states must survive intact. */
export function typeManagementRecordsEqual(left: unknown, right: unknown): boolean {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, canonical(record[key])]),
      );
    }
    return value;
  }
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}
