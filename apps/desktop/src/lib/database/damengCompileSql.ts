export interface DamengCompileViewSqlInput {
  schema?: string | null;
  name: string;
}

export function buildDamengCompileViewSql(input: DamengCompileViewSqlInput): string | null {
  const name = input.name.trim();
  if (!name) return null;
  const schema = input.schema?.trim();
  const qualifiedName = schema ? `${quoteDamengIdentifier(schema)}.${quoteDamengIdentifier(name)}` : quoteDamengIdentifier(name);
  return `ALTER VIEW ${qualifiedName} COMPILE;`;
}

function quoteDamengIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
