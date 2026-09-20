import { formatError } from "@/lib/backend/errorUtils";

export function favoriteErrorMessage(error: unknown, t: (key: string) => string): string {
  const detail = formatError(error);
  if (detail.startsWith("FAVORITE_UNSUPPORTED_TARGET:")) return t("favorites.unsupportedTarget");
  const key = ({ FAVORITE_CODE_CONFLICT: "codeConflict", FAVORITE_REVISION_CONFLICT: "revisionConflict", FAVORITE_TARGET_CONFLICT: "targetConflict", FAVORITE_NOT_FOUND: "notFound", CONNECTION_NOT_FOUND: "connectionMissing", FAVORITE_CONTEXT_CHANGED: "contextChanged" } as Record<string, string>)[
    detail.split(":")[0]
  ];
  return key ? t(`favorites.${key}`) : detail;
}
