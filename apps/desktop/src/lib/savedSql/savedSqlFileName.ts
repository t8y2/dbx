export function ensureSqlExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return /\.sql$/i.test(trimmed) ? trimmed : `${trimmed}.sql`;
}

export function stripSqlExtension(name: string): string {
  return name.replace(/\.sql$/i, "");
}
