import type { SqlFilePreview } from "@/lib/backend/api";

/**
 * Build a map from filePath to a user-facing display label.
 *
 * Desktop (Tauri): real filesystem paths are available. When multiple files
 * share the same fileName, prepend parent directory segments until each gets
 * a unique label (e.g. migration/create.sql vs seed/create.sql).
 *
 * Web: browser File.name has no path (security restriction), and the server
 * stores uploads as <stem>-<UUID>.sql temp paths. Path-based disambiguation
 * would leak meaningless UUIDs, so use a stable 1-based index suffix instead
 * (e.g. create.sql, create.sql (2), create.sql (3)).
 */
export function buildDisplayFileNames(items: SqlFilePreview[], isDesktop: boolean): Map<string, string> {
  const byFileName = new Map<string, SqlFilePreview[]>();
  for (const item of items) {
    const list = byFileName.get(item.fileName) ?? [];
    list.push(item);
    byFileName.set(item.fileName, list);
  }
  const result = new Map<string, string>();
  for (const [, group] of byFileName) {
    if (group.length === 1) {
      result.set(group[0]!.filePath, group[0]!.fileName);
      continue;
    }
    if (isDesktop) {
      for (const item of group) {
        const parts = item.filePath.replace(/\\/g, "/").split("/");
        for (let depth = 2; depth <= parts.length; depth++) {
          const candidate = parts.slice(parts.length - depth).join("/");
          const isUnique = !group.some((o) => o.filePath !== item.filePath && o.filePath.replace(/\\/g, "/").split("/").slice(-depth).join("/") === candidate);
          if (isUnique) {
            result.set(item.filePath, candidate);
            break;
          }
        }
        if (!result.has(item.filePath)) {
          result.set(item.filePath, item.filePath.replace(/\\/g, "/"));
        }
      }
    } else {
      group.forEach((item, index) => {
        result.set(item.filePath, index === 0 ? item.fileName : `${item.fileName} (${index + 1})`);
      });
    }
  }
  return result;
}

/**
 * Desktop tooltip shows the real file path; Web tooltip shows the user-facing
 * label only — never the server temp path (which contains a meaningless UUID).
 */
export function tooltipText(item: SqlFilePreview, displayNames: Map<string, string>, isDesktop: boolean): string {
  return isDesktop ? item.filePath : (displayNames.get(item.filePath) ?? item.fileName);
}
