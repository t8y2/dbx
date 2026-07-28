import type { DatabaseType } from "@/types/database";
import type { DataGridEditAdapter } from "@/lib/dataGrid/dataGridRuntime";

export type DataGridEditAdapterKind = "relational" | "document" | "custom" | "unsupported";

export interface DataGridEditAdapterContext {
  databaseType?: DatabaseType;
  custom: boolean;
  editable: boolean;
}

export function dataGridEditAdapterKind(context: DataGridEditAdapterContext): DataGridEditAdapterKind {
  if (context.custom) return "custom";
  if (!context.editable) return "unsupported";
  if (context.databaseType === "mongodb") return "document";
  if (context.databaseType) return "relational";
  return "unsupported";
}

export type { DataGridEditAdapter };
