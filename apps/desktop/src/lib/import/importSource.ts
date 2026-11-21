export type ImportFileSource = string | File;

export interface UploadedImportSource {
  sourceRef: string;
  filePath: string;
}

export function importSourceDisplayName(source: ImportFileSource): string {
  return typeof source === "string" ? source.split(/[\\/]/).pop() || source : source.name;
}

export function importTextDelimiterForName(name: string): string {
  return name.toLowerCase().endsWith(".tsv") ? "\\t" : ",";
}

/** Reuse a server-side upload on later previews instead of sending the File again. */
export function importPreviewInput(uploaded: UploadedImportSource | null | undefined, source: ImportFileSource): { fileOrPath: ImportFileSource; sourceRef: string | null } {
  if (uploaded?.sourceRef) return { fileOrPath: uploaded.filePath, sourceRef: uploaded.sourceRef };
  return { fileOrPath: source, sourceRef: null };
}

export function uploadedImportSourceFromPreview(preview: { sourceRef?: string | null; filePath?: string } | null | undefined): UploadedImportSource | null {
  if (!preview?.sourceRef || !preview.filePath) return null;
  return { sourceRef: preview.sourceRef, filePath: preview.filePath };
}
