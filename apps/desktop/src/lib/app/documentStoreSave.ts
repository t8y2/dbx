import type { DocumentStoreKind } from "@/lib/app/documentStoreProvider";
import { prepareDocumentStoreWriteDocument, stringifyDocumentStoreValue, type DocumentStoreIdentityPlan } from "@/lib/app/documentJsonValues";

export type DocumentStoreWriteApis = {
  insert: (docJson: string, routing?: string) => Promise<string>;
  update: (id: string, docJson: string, routing?: string) => Promise<number>;
  delete: (id: string, routing?: string) => Promise<number>;
};

export function formatMeilisearchDocumentOperationPreview(options: { action: "insert" | "upsert" | "update" | "delete"; index: string; id?: unknown; document?: Record<string, unknown> }): string {
  const lines = [`DBX MEILISEARCH ${options.action.toUpperCase()} DOCUMENT`, `index: ${JSON.stringify(options.index)}`];
  if (options.id !== undefined) lines.push(`id: ${stringifyDocumentStoreValue(options.id, "meilisearch")}`);
  if (options.document) lines.push("document:", stringifyDocumentStoreValue(options.document, "meilisearch", 2));
  return lines.join("\n");
}

/**
 * Write a document body under a known identity.
 * - `put`: Elasticsearch index-by-id / Mongo update-by-id (identity via path, not body).
 * - `insert`: Mongo insert (and ES auto-id when no explicit id); routing is always an API arg.
 */
export async function writeDocumentStoreDocument(options: { kind: DocumentStoreKind; op: "put" | "insert"; id?: string; routing?: string; document: Record<string, unknown>; apis: Pick<DocumentStoreWriteApis, "insert" | "update"> }): Promise<void> {
  const prepared = prepareDocumentStoreWriteDocument(options.document, {
    kind: options.kind,
    mode: options.op === "put" ? "update" : "insert",
  });
  const body = stringifyDocumentStoreValue(prepared, options.kind);

  if (options.op === "put") {
    if (!options.id) throw new Error("Document write requires an id");
    await options.apis.update(options.id, body, options.routing);
    return;
  }

  await options.apis.insert(body, options.routing);
}

/**
 * Apply an identity plan for an existing document save.
 * DynamoDB rekeys atomically in the backend. Other stores write first, then
 * delete the old identity so a failed write never deletes the source.
 * Plan coordinates are assumed distinct for rekey (same identity is always `replace`).
 */
export async function applyDocumentStoreIdentityPlan(options: { kind: DocumentStoreKind; plan: DocumentStoreIdentityPlan; document: Record<string, unknown>; apis: DocumentStoreWriteApis }): Promise<void> {
  const { kind, plan, document, apis } = options;

  // DynamoDB handles both same-key replacement and key migration in the
  // backend. Rekey uses one TransactWriteItems request, keyed by the old id.
  if (kind === "dynamodb") {
    await writeDocumentStoreDocument({
      kind,
      op: "put",
      id: plan.action === "rekey" ? plan.deleteId : plan.writeId,
      document,
      apis,
    });
    return;
  }

  if (plan.action === "replace") {
    await writeDocumentStoreDocument({
      kind,
      op: "put",
      id: plan.writeId,
      routing: plan.writeRouting,
      document,
      apis,
    });
    return;
  }

  if (kind !== "mongodb") {
    await writeDocumentStoreDocument({
      kind,
      op: "put",
      id: plan.writeId,
      routing: plan.writeRouting,
      document,
      apis,
    });
  } else {
    await writeDocumentStoreDocument({
      kind,
      op: "insert",
      document,
      apis,
    });
  }

  // Only reached after a successful write — preserves the old document when write fails.
  await apis.delete(plan.deleteId, plan.deleteRouting);
}

/** Insert a new document (optional explicit path identity uses put). */
export async function insertDocumentStoreDocument(options: { kind: DocumentStoreKind; document: Record<string, unknown>; explicitId?: string | null; routing?: string; apis: Pick<DocumentStoreWriteApis, "insert" | "update"> }): Promise<void> {
  const { kind, document, explicitId, routing, apis } = options;
  if (kind !== "mongodb" && kind !== "dynamodb" && explicitId) {
    await writeDocumentStoreDocument({
      kind,
      op: "put",
      id: explicitId,
      routing,
      document,
      apis,
    });
    return;
  }

  await writeDocumentStoreDocument({
    kind,
    op: "insert",
    routing,
    document,
    apis,
  });
}
