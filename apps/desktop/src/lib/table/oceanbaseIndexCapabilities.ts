export function oceanbaseIndexCapabilities(version?: string | null) {
  const value = version?.trim() ?? "";
  const documented = /^[vV]?4\.2\.5(?:$|[.-])/.test(value);
  const types: string[] = documented ? ["NORMAL", "FUNCTION-BASED NORMAL"] : ["NORMAL"];
  return {
    types,
    status: documented ? "documented" : value ? "unverified" : "unavailable",
  } as const;
}

export function quoteOceanbaseIndexColumn(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Only switch back when every SQL term is an exact quoted physical column. */
export function oceanbasePhysicalIndexColumns(terms: string[], columns: string[]): string[] | undefined {
  const names = terms.map((term) => columns.find((name) => quoteOceanbaseIndexColumn(name) === term.trim()));
  return names.every((name): name is string => name !== undefined) ? names : undefined;
}
