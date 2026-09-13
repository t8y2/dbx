import { dbxWebBasePath, webPath } from "@/lib/common/webPath";

/** Path (with base) that renders the minimal shared data-view page. */
export function dataViewSharePath(id: string): string {
  return webPath(`/data-view/${encodeURIComponent(id)}`);
}

/** Absolute URL for sharing a data view on the same dbx-web instance. */
export function dataViewShareUrl(id: string, origin = globalThis.location?.origin ?? ""): string {
  return `${origin}${dataViewSharePath(id)}`;
}

/** Extracts the data-view id from a share URL pathname, or null if this
 *  location is not a share page. */
export function parseDataViewShareLocation(pathname = globalThis.location?.pathname ?? "", basePath = dbxWebBasePath()): string | null {
  let rest = pathname;
  if (basePath && rest.startsWith(basePath)) rest = rest.slice(basePath.length);
  const match = rest.match(/^\/data-view\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}
