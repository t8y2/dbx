import type { DocumentStoreKind } from "@/lib/app/documentStoreProvider";
import { prepareDocumentStoreWriteDocument, stringifyDocumentStoreValue, type DocumentStoreIdentityPlan } from "@/lib/app/documentJsonValues";

export type DocumentStoreWriteApis = {
  insert: (docJson: string, routing?: string) => Promise<string>;
  update: (id: string, docJson: string, routing?: string) => Promise<number>;
  delete: (id: string, routing?: string) => Promise<number>;
};

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
 * Rekey always writes first, then deletes the old identity — a failed write never deletes.
 * Plan coordinates are assumed distinct for rekey (same identity is always `replace`).
 */
export async function applyDocumentStoreIdentityPlan(options: { kind: DocumentStoreKind; plan: DocumentStoreIdentityPlan; document: Record<string, unknown>; apis: DocumentStoreWriteApis }): Promise<void> {
  const { kind, plan, document, apis } = options;

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

  // Rekey write: ES uses put under the new id/routing; Mongo inserts a new document then deletes the old id.
  if (kind === "elasticsearch") {
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

/** Insert a new document (optional explicit ES id uses put). */
export async function insertDocumentStoreDocument(options: { kind: DocumentStoreKind; document: Record<string, unknown>; explicitId?: string | null; routing?: string; apis: Pick<DocumentStoreWriteApis, "insert" | "update"> }): Promise<void> {
  const { kind, document, explicitId, routing, apis } = options;
  if (kind === "elasticsearch" && explicitId) {
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
