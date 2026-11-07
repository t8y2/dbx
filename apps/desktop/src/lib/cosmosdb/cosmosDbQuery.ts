const COSMOS_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Starter query for an Azure Cosmos DB container. The driver resolves the
 * container from the FROM clause; ids that are not Cosmos SQL identifiers
 * (for example `order-items`) are quoted, and the driver sends them as `ROOT`.
 */
export function cosmosDbContainerQueryTemplate(container: string): string {
  if (COSMOS_SQL_IDENTIFIER.test(container)) return `SELECT * FROM ${container} c`;
  return `SELECT * FROM ${JSON.stringify(container)} c`;
}
