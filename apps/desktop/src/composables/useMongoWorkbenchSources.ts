import { ref } from "vue";

export interface MongoWorkbenchSource {
  connectionId: string;
  database: string;
  collection: string;
}
export interface MongoWorkbenchDialogSource extends MongoWorkbenchSource {
  open: boolean;
}

const aggregationSource = ref<MongoWorkbenchDialogSource | null>(null);
const schemaSource = ref<MongoWorkbenchDialogSource | null>(null);
const transformSource = ref<MongoWorkbenchDialogSource | null>(null);
const sqlSource = ref<MongoWorkbenchDialogSource | null>(null);
const scriptSource = ref<MongoWorkbenchDialogSource | null>(null);
const tasksSource = ref<MongoWorkbenchDialogSource | null>(null);
const migrationSource = ref<MongoWorkbenchDialogSource | null>(null);
export function openMongoTasks(source: MongoWorkbenchSource = { connectionId: "", database: "", collection: "" }) {
  tasksSource.value = { ...source, open: true };
}
export function openMongoMigration(source: MongoWorkbenchSource = { connectionId: "", database: "", collection: "" }) {
  migrationSource.value = { ...source, open: true };
}
export function openMongoScript(source: MongoWorkbenchSource = { connectionId: "", database: "", collection: "" }) {
  scriptSource.value = { ...source, open: true };
}
export function openMongoSql(source: MongoWorkbenchSource = { connectionId: "", database: "", collection: "" }) {
  sqlSource.value = { ...source, open: true };
}

export function openMongoTransform(source: MongoWorkbenchSource = { connectionId: "", database: "", collection: "" }) {
  transformSource.value = { ...source, open: true };
}

export function openMongoAggregation(source: MongoWorkbenchSource = { connectionId: "", database: "", collection: "" }) {
  aggregationSource.value = { ...source, open: true };
}
export function openMongoSchemaAnalysis(source: MongoWorkbenchSource = { connectionId: "", database: "", collection: "" }) {
  schemaSource.value = { ...source, open: true };
}
export function useMongoWorkbenchSources() {
  return { aggregationSource, schemaSource, transformSource, sqlSource, scriptSource, tasksSource, migrationSource };
}
