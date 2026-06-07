export function parseSlashDelimitedRegexQuery(query: string): RegExp | null {
  if (!query.startsWith("/") || query.length < 2) return null;
  const lastSlash = query.lastIndexOf("/");
  if (lastSlash <= 0) return null;

  const source = query.slice(1, lastSlash);
  const flags = query.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) return null;

  try {
    return new RegExp(source, flags.includes("i") ? flags : `${flags}i`);
  } catch {
    return null;
  }
}
