import * as api from "@/lib/backend/api";
import { useExportTracker } from "@/composables/useExportTracker";
import { emptyAnnotations } from "@/docs/annotationEdits";
import type { SchemaSnapshot, SnapshotWarning } from "@/docs/types";
import { uuid } from "@/lib/common/utils";
import { exportBlockedBySkippedTables, objectKey, orderDictionaryTables, warningsForSelection, type DataDictionaryLabels, type DictionaryLayout, type DictionaryObjectRef, type DictionaryTable } from "./dataDictionary";
import { renderDataDictionaryPdf } from "./renderDataDictionaryPdf";
import { saveDataDictionaryFile } from "./saveDataDictionaryFile";

export interface DictionaryExportRequest {
  connectionId: string;
  databases: string[];
  schemas: Array<{ database: string; name: string }>;
  objects: DictionaryObjectRef[];
  snapshot?: SchemaSnapshot | null;
  layout: DictionaryLayout;
  labels: DataDictionaryLabels;
  outputPath: string;
  overwrite: boolean;
  continueOnError: boolean;
  warningText: (warning: SnapshotWarning) => string;
  skippedDatabase: (database: string, reason: string) => string;
  missingObject: (object: DictionaryObjectRef) => string;
  onSuccess: (path: string, warnings: number) => void;
  onFailure: (error: unknown) => void;
}

// Export lifetimes belong to the app, not the dialog instance. One job per
// connection also bounds the aggregate metadata pressure on its pool.
const activeConnections = new Set<string>();

export function hasActiveDictionaryExport(connectionId: string): boolean {
  return activeConnections.has(connectionId);
}

export function startDataDictionaryExport(request: DictionaryExportRequest): boolean {
  if (activeConnections.has(request.connectionId)) return false;
  activeConnections.add(request.connectionId);
  const tracker = useExportTracker();
  const id = uuid();
  tracker.addDataDictionaryTask(id, request.databases.join(", "), request.objects.length);

  void (async () => {
    const warnings: string[] = [];
    const tables: DictionaryTable[] = [];
    const order = request.objects.map(objectKey);
    let completed = 0;
    try {
      for (const database of request.databases) {
        const selected = request.objects.filter((item) => item.database === database);
        if (!selected.length) continue;
        tracker.updateDataDictionaryTask(id, { dictionaryPhase: "preparing", dictionaryCompleted: completed, dictionaryCurrent: database });
        try {
          let merged: SchemaSnapshot;
          const fromSnapshot =
            request.snapshot?.project.database === database
              ? orderDictionaryTables(
                  request.snapshot.tables.map((table) => ({ ...table, database })),
                  selected.map(objectKey),
                )
              : [];
          if (request.snapshot && fromSnapshot.length === selected.length) {
            merged = request.snapshot;
            tracker.updateDataDictionaryTask(id, { dictionaryPhase: "collecting", dictionaryProgressKnown: true });
          } else {
            const schemas = request.schemas.filter((item) => item.database === database).map((item) => item.name);
            const names = selected.map((item) => (item.schema ? `${item.schema}.${item.name}` : item.name));
            const baseCompleted = completed;
            let acceptingProgress = true;
            let raw: SchemaSnapshot;
            try {
              raw = await api.collectDocsSnapshotForExport(request.connectionId, database, schemas, names, (progress) => {
                if (!acceptingProgress) return;
                const task = tracker.tasks.value.find((item) => item.exportId === id);
                tracker.updateDataDictionaryTask(id, {
                  dictionaryPhase: "collecting",
                  dictionaryProgressKnown: progress.total > 0,
                  dictionaryCompleted: Math.max(task?.dictionaryCompleted ?? 0, baseCompleted + Math.min(progress.completed, selected.length)),
                  dictionaryCurrent: progress.current || database,
                });
              });
            } finally {
              acceptingProgress = false;
            }
            const file = (await api.loadDocsAnnotations(request.connectionId)) ?? emptyAnnotations();
            merged = await api.applyDocsAnnotations(request.connectionId, raw, file);
          }
          const relevant = warningsForSelection(merged.warnings, selected);
          const collected = new Set(merged.tables.map((table) => objectKey({ database, schema: table.schema ?? "", name: table.name })));
          const missing = selected.filter((item) => !collected.has(objectKey(item)));
          const missingWarnings = missing.filter((item) => !relevant.some((warning) => warning.kind === "tableSkipped" && (warning.table === "*" || warning.table === `${item.schema}.*` || warning.table === item.name || warning.table === `${item.schema}.${item.name}`))).map(request.missingObject);
          if (exportBlockedBySkippedTables(relevant, request.continueOnError) || (!request.continueOnError && missingWarnings.length > 0)) {
            throw new Error(relevant.map(request.warningText).find(Boolean) || missingWarnings[0] || database);
          }
          warnings.push(...relevant.map(request.warningText).filter(Boolean));
          warnings.push(...missingWarnings);
          tables.push(...merged.tables.filter((table) => selected.some((item) => objectKey(item) === objectKey({ database, schema: table.schema ?? "", name: table.name }))).map((table) => ({ ...table, database })));
        } catch (error) {
          if (!request.continueOnError) throw error;
          warnings.push(request.skippedDatabase(database, error instanceof Error ? error.message : String(error)));
        }
        completed += selected.length;
        tracker.updateDataDictionaryTask(id, { dictionaryCompleted: completed, dictionaryCurrent: "", dictionaryWarnings: warnings.length });
      }
      if (!tables.length) throw new Error("No selected objects could be collected");
      tracker.updateDataDictionaryTask(id, { dictionaryPhase: "generating", dictionaryCurrent: "" });
      // Worker messages cannot clone Vue proxies; capture only serializable metadata.
      const ordered = JSON.parse(JSON.stringify(orderDictionaryTables(tables, order))) as DictionaryTable[];
      const bytes = await renderDataDictionaryPdf(ordered, request.labels, request.layout, request.continueOnError ? warnings : []);
      tracker.updateDataDictionaryTask(id, { dictionaryPhase: "saving", status: "Writing" });
      const path = await saveDataDictionaryFile(request.outputPath, bytes, { overwrite: request.overwrite, grantedPath: request.outputPath });
      if (!path) throw new Error("File was not saved");
      tracker.updateDataDictionaryTask(id, { status: "Done", filePath: path, dictionaryWarnings: warnings.length });
      request.onSuccess(path, warnings.length);
    } catch (error) {
      tracker.updateDataDictionaryTask(id, { status: "Error", errorMessage: error instanceof Error ? error.message : String(error) });
      request.onFailure(error);
    } finally {
      activeConnections.delete(request.connectionId);
    }
  })();
  return true;
}
