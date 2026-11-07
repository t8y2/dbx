export type RelationalNavigationSelection = { kind: "all" } | { kind: "named"; name: string };

export interface RelationalNavigationContainer {
  connectionId: string;
  kind: "database" | "schema";
  catalog?: string;
  database?: string;
  linkedServer?: string;
  linkedCatalog?: string;
  linkedSchema?: string;
}

export function relationalNavigationContainerKey(container: RelationalNavigationContainer): string {
  return JSON.stringify([container.connectionId, container.catalog ?? null, container.database ?? null, container.linkedServer ?? null, container.linkedCatalog ?? null, container.linkedSchema ?? null, container.kind]);
}

export function resolveRelationalNavigationSelection(options: { saved?: RelationalNavigationSelection; defaultName?: string; availableNames: readonly string[]; discoveryComplete: boolean }): RelationalNavigationSelection {
  const { saved, defaultName, availableNames, discoveryComplete } = options;
  if (saved?.kind === "all") return saved;
  if (saved?.kind === "named" && (!discoveryComplete || availableNames.includes(saved.name))) return saved;
  if (defaultName !== undefined && (!discoveryComplete || availableNames.includes(defaultName))) return { kind: "named", name: defaultName };
  return { kind: "all" };
}

export function parseRelationalNavigationSelections(value: string | null): Record<string, RelationalNavigationSelection> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, RelationalNavigationSelection] => {
        const selection = entry[1];
        return selection !== null && typeof selection === "object" && (selection.kind === "all" || (selection.kind === "named" && typeof selection.name === "string"));
      }),
    );
  } catch {
    return {};
  }
}
