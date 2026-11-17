import type { DatabaseType } from "@/types/database";
import { isDangerousSolrRequest } from "@/lib/solr/solrRequestRisk";
import { isDangerousCouchDbRequest } from "@/lib/couchdb/couchdbRequestRisk";
import { parseElasticsearchRestRequestTarget, splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";

const DANGER_RE = /^\s*(DROP|DELETE|TRUNCATE|ALTER|UPDATE|MERGE|REPLACE)\b/i;

export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--.*$/gm, " ")
    .replace(/#.*$/gm, " ");
}

const ELASTICSEARCH_TRANSIENT_DELETE_PATHS = [/^\/_search\/scroll\/?$/i, /^\/_pit\/?$/i, /^\/_async_search\/[^/?]+\/?$/i];
const ELASTICSEARCH_DESTRUCTIVE_POST_PATHS = [/(?:^|\/)_(?:delete_by_query|update_by_query|bulk)(?:\/|$)/i, /^\/_reindex(?:\/|$)/i, /^\/_aliases(?:\/|$)/i, /\/_restore(?:\/|$)/i];

function isDangerousElasticsearchRequest(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD", path: string): boolean {
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
  if (method === "DELETE") return !ELASTICSEARCH_TRANSIENT_DELETE_PATHS.some((pattern) => pattern.test(pathname));
  if (method === "PUT" || method === "PATCH") return true;
  return method === "POST" && ELASTICSEARCH_DESTRUCTIVE_POST_PATHS.some((pattern) => pattern.test(pathname));
}

function isDangerousMeilisearchRequest(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD", path: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (method === "DELETE" || method === "PUT" || method === "PATCH") return true;
  const pathname = path.split("?", 1)[0].replace(/\/+$/, "") || "/";
  return !(pathname === "/multi-search" || /\/search$/i.test(pathname) || /\/facet-search$/i.test(pathname) || /\/similar$/i.test(pathname) || /\/documents\/fetch$/i.test(pathname));
}

export function isDangerousSql(sql: string, databaseType?: DatabaseType): boolean {
  if (databaseType === "elasticsearch" || databaseType === "easysearch" || databaseType === "meilisearch" || databaseType === "solr" || databaseType === "couchdb") {
    const requests = splitSqlStatementRanges(sql, databaseType)
      .map((statement) => parseElasticsearchRestRequestTarget(statement.sql))
      .filter((request): request is NonNullable<typeof request> => request !== null);
    if (requests.length > 0) {
      return requests.some((request) =>
        databaseType === "meilisearch"
          ? isDangerousMeilisearchRequest(request.method, request.path)
          : databaseType === "solr"
            ? isDangerousSolrRequest(request.method, request.path)
            : databaseType === "couchdb"
              ? isDangerousCouchDbRequest(request.method, request.path)
              : isDangerousElasticsearchRequest(request.method, request.path),
      );
    }
  }
  const cleaned = stripSqlComments(sql);
  return cleaned.split(";").some((stmt) => DANGER_RE.test(stmt));
}
