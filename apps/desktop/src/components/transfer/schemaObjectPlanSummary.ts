import type { TransferSchemaObjectPreview } from "@/lib/backend/api";

type Translate = (key: string) => string;

export function describeTransferSchemaObjects(preview: TransferSchemaObjectPreview | undefined, t: Translate): string[] {
  if (!preview) return [];
  const actionKeys = { create: "objectActionCreate", replace: "objectActionReplace", skip: "objectActionSkip", blocked: "objectActionBlocked" };
  return preview.items.flatMap((item) => [
    `${item.objectType} ${item.sourceSchema}.${item.name} → ${item.targetSchema}.${item.name}: ${t(`transfer.${actionKeys[item.action]}`)}`,
    ...item.dependencies.map((dependency) => `${t("transfer.objectDependencies")}: ${dependency.objectType} ${dependency.owner}.${dependency.name} — ${t(dependency.available ? "transfer.objectDependencyAvailable" : "transfer.objectDependencyMissing")}`),
    ...item.warnings,
    ...item.errors,
  ]);
}
