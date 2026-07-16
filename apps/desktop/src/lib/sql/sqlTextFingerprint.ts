function fnv1a(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function sqlTextFingerprint(sql: string): string {
  const first = fnv1a(sql, 0x811c9dc5).toString(16).padStart(8, "0");
  const second = fnv1a(sql, 0x9e3779b9).toString(16).padStart(8, "0");
  return `${sql.length.toString(16)}:${first}${second}`;
}
