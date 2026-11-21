export type MongoDumpFormat = "directory" | "archive";
export type MongoDumpSourceInput = string | File | File[];

export interface MongoDumpCollection {
  database: string;
  name: string;
  kind: string;
  documents: number | null;
  sizeBytes: number;
  indexes: number;
  sourceFiles?: string[];
}
export interface MongoDumpCatalog {
  databases: string[];
  collections: MongoDumpCollection[];
}
export interface MongoRestoreSourcePreview extends MongoDumpCatalog {
  sourceRef: string;
}
export interface MongoDatabaseDumpRequest {
  taskId: string;
  connectionId: string;
  database: string;
  filePath: string;
  format: MongoDumpFormat;
  gzip: boolean;
  collections?: string[];
}
export interface MongoDatabaseRestoreRequest {
  taskId: string;
  connectionId: string;
  database: string;
  sourceDatabase: string;
  sourceRef: string;
  collections?: string[];
  dropExisting: boolean;
  restoreOptions: boolean;
  restoreIndexes: boolean;
  stopOnError: boolean;
  objcheck?: boolean;
  batchSize: number;
  executionId?: string;
}
export interface MongoDatabaseDumpProgress {
  taskId: string;
  status: "running" | "done" | "error" | "cancelled";
  phase: "preparing" | "uploading" | "validating" | "data" | "indexes" | "views" | "archive" | "done";
  collection: string | null;
  collectionsDone: number;
  collectionsTotal: number;
  documentsRead: number;
  documentsWritten: number;
  documentsFailed: number;
  indexesCreated: number;
  elapsedMs: number;
  errorMessage: string | null;
  filePath: string | null;
  bytesProcessed?: number;
  bytesTotal?: number;
  documentsValidated?: number;
}

export interface MongoRestoreUpload {
  files: File[];
  gzip: boolean;
  signal?: AbortSignal;
}

export interface MongoSourceReadOptions {
  signal?: AbortSignal;
  onUploadProgress?: (loaded: number, total: number) => void;
}
