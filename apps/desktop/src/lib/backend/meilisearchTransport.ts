import { parseJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";

export type MeilisearchSearchHit = {
  id?: unknown;
  document: Record<string, unknown>;
  formatted?: Record<string, unknown>;
  rankingScore?: unknown;
};

export type MeilisearchSearchResult = {
  hits: MeilisearchSearchHit[];
  totalHits: number;
  processingTimeMs: number;
};

export type MeilisearchSearchWireResult = {
  hits: Array<{
    idJson?: string;
    documentJson: string;
    formattedJson?: string;
    rankingScoreJson?: string;
  }>;
  totalHits: number;
  processingTimeMs: number;
};

export type MeilisearchDocumentPage = {
  documents: Record<string, unknown>[];
  total: number;
};

export type MeilisearchDocumentPageWire = {
  documentsJson: string[];
  total: number;
};

function parseJsonObject(json: string, context: string): Record<string, unknown> {
  const value = parseJsonPreservingLargeNumbers(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Meilisearch ${context} payload`);
  }
  return value as Record<string, unknown>;
}

export function decodeMeilisearchSearchResult(result: MeilisearchSearchWireResult): MeilisearchSearchResult {
  return {
    hits: result.hits.map((hit) => ({
      id: hit.idJson === undefined ? undefined : parseJsonPreservingLargeNumbers(hit.idJson),
      document: parseJsonObject(hit.documentJson, "document"),
      formatted: hit.formattedJson === undefined ? undefined : parseJsonObject(hit.formattedJson, "formatted document"),
      rankingScore: hit.rankingScoreJson === undefined ? undefined : parseJsonPreservingLargeNumbers(hit.rankingScoreJson),
    })),
    totalHits: result.totalHits,
    processingTimeMs: result.processingTimeMs,
  };
}

export function decodeMeilisearchDocumentPage(page: MeilisearchDocumentPageWire): MeilisearchDocumentPage {
  return {
    documents: page.documentsJson.map((document) => parseJsonObject(document, "document")),
    total: page.total,
  };
}
