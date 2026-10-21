export type OracleInvalidObjectCompileScope = {
  connectionId: string;
  database: string;
  schema: string;
};

function sameScope(left: OracleInvalidObjectCompileScope, right: OracleInvalidObjectCompileScope): boolean {
  return left.connectionId === right.connectionId && left.database === right.database && left.schema === right.schema;
}

export async function completeOracleInvalidObjectCompile(
  completed: OracleInvalidObjectCompileScope,
  getCurrent: () => OracleInvalidObjectCompileScope,
  invalidate: (scope: OracleInvalidObjectCompileScope) => Promise<void>,
  refresh: (scope: OracleInvalidObjectCompileScope) => Promise<void>,
): Promise<void> {
  await invalidate(completed);
  const current = getCurrent();
  if (sameScope(completed, current)) await refresh(current);
}
