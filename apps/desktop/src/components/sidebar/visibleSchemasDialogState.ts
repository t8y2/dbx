export function initialVisibleSchemaSelection(schemaNames: string[], configured: string[] | undefined): Set<string> {
  if (!configured) return new Set(schemaNames);
  return new Set(configured);
}

export function selectVisibleSchemas(schemaNames: string[]): Set<string> {
  return new Set(schemaNames);
}

export function addVisibleSchemas(selection: Set<string>, schemaNames: string[]): Set<string> {
  const next = new Set(selection);
  for (const name of schemaNames) next.add(name);
  return next;
}
