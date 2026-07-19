/** Preserve database-specific default expressions exactly; only absent metadata gets a placeholder. */
export function tableColumnDefaultDisplayValue(value: string | null | undefined): string {
  return value ?? "—";
}
