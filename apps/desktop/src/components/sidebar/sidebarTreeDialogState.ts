import { ref, shallowRef } from "vue";
import type { TreeNode } from "@/types/database";
import type { PasteTableMode } from "@/lib/table/tableClipboard";
import { fallbackCreateDatabaseCharsetMetadata } from "@/lib/database/createDatabaseCharsetOptions";
import type { DatabaseUserIdentity } from "@/lib/database/databaseUserAdmin";
import type { AuthorizationPlan, AuthorizationStepResult } from "@/lib/database/databaseAuthorizationPlan";

export type DuplicateStructureSource = TreeNode & { connectionId: string; database: string };
type ConnectionDeleteTarget = TreeNode & { connectionId: string };

export const fallbackCreateDatabaseCharset = fallbackCreateDatabaseCharsetMetadata();

export const sidebarTreeDialogOwner = shallowRef<symbol | null>(null);
export const sidebarDangerTarget = shallowRef<TreeNode | null>(null);
export const sidebarFormTarget = shallowRef<TreeNode | null>(null);
export const connectionDeleteTargetSnapshot = ref<ConnectionDeleteTarget[]>([]);
export const showDeleteConfirm = ref(false);
export const showDropTableConfirm = ref(false);
export const showDropTableChildObjectConfirm = ref(false);
export const showBatchDropConfirm = ref(false);
export const showBatchEmptyConfirm = ref(false);
export const showBatchTruncateConfirm = ref(false);
export const showStructurePreviewDialog = ref(false);
export const showStructureDocCopyDialog = ref(false);
export const structurePreviewSql = ref("");
export const structurePreviewTitle = ref("");
export const structurePreviewDefaultFileName = ref("structure.sql");
export const structurePreviewError = ref("");
export const structureDocCopyText = ref("");
export const structureDocCopyTitle = ref("");
export const isLoadingStructurePreview = ref(false);
export const showEmptyTableConfirm = ref(false);
export const showTruncateTableConfirm = ref(false);
export const showRenameObjectDialog = ref(false);
export const renameObjectName = ref("");
export const renameObjectError = ref("");
export const renameObjectPreviewSql = ref("");
export const dropTablePreviewSql = ref("");
export const dropTableCascade = ref(false);
export const batchDropCascade = ref(false);
export const emptyTablePreviewSql = ref("");
export const truncateTablePreviewSql = ref("");
export const truncateTableCascade = ref(false);
export const dropObjectPreviewSql = ref("");
export const showDropObjectConfirm = ref(false);
export const dropTableChildObjectPreviewSql = ref("");
export const batchDropPreviewSql = ref("");
export const batchEmptyPreviewSql = ref("");
export const batchEmptyTargets = ref<TreeNode[]>([]);
export const batchDropTargets = ref<TreeNode[]>([]);
export const batchTruncateTargets = ref<TreeNode[]>([]);
export const batchTruncatePreviewSql = ref("");
export const batchTruncateCascade = ref(false);
export const dropDatabasePreviewSql = ref("");
export const dropSchemaPreviewSql = ref("");
export const showDuplicateDialog = ref(false);
export const duplicateTableName = ref("");
export const duplicateStructureSource = ref<DuplicateStructureSource | null>(null);
export const showPasteDialog = ref(false);
export const pasteTableMode = ref<PasteTableMode>("structure-and-data");
export const pasteTableEntries = ref<Array<{ sourceName: string; targetName: string; connectionId: string; database: string; schema?: string }>>([]);
export const showCreateDatabaseDialog = ref(false);
export const createDatabaseName = ref("");
export const createDatabaseCharset = ref("utf8mb4");
export const createDatabaseCollation = ref("utf8mb4_unicode_ci");
export const createDatabaseUsers = ref<DatabaseUserIdentity[]>([]);
export const createDatabaseSelectedUsers = ref<DatabaseUserIdentity[]>([]);
export const createDatabaseUsersLoading = ref(false);
export const showCreateDatabasePreviewDialog = ref(false);
export const createDatabaseAuthorizationPlan = ref<AuthorizationPlan>();
export const createDatabasePreviewSql = ref("");
export const createDatabaseAuthorizationResults = ref<AuthorizationStepResult[]>([]);
export const createDatabaseAuthorizationApplying = ref(false);
export const showCreateNacosNamespaceDialog = ref(false);
export const createNacosNamespaceId = ref("");
export const createNacosNamespaceName = ref("");
export const createNacosNamespaceDesc = ref("");
export const createNacosNamespaceLoading = ref(false);
export const showEditNacosNamespaceDialog = ref(false);
export const editNacosNamespaceName = ref("");
export const editNacosNamespaceDesc = ref("");
export const editNacosNamespaceLoading = ref(false);
export const createDatabaseCharsetOptions = ref<string[]>(fallbackCreateDatabaseCharset.charsets);
export const createDatabaseCollationsByCharset = ref<Record<string, string[]>>(fallbackCreateDatabaseCharset.collationsByCharset);
export const createDatabaseCharsetLoading = ref(false);
export const showDropDatabaseConfirm = ref(false);
export const dropDatabaseLoading = ref(false);
export const showDropMongoCollectionConfirm = ref(false);
export const dropMongoCollectionLoading = ref(false);
export const showRenameMongoCollectionDialog = ref(false);
export const renameMongoCollectionName = ref("");
export const renameMongoCollectionError = ref("");
export const renameMongoCollectionPreview = ref("");
export const renameMongoCollectionLoading = ref(false);
export const showDropMongoIndexConfirm = ref(false);
export const dropMongoIndexLoading = ref(false);
export const showDropAllMongoIndexesConfirm = ref(false);
export const dropAllMongoIndexesLoading = ref(false);
export const showFlushRedisDbConfirm = ref(false);
export const showCreateSchemaDialog = ref(false);
export const createSchemaName = ref("");
export const showDropSchemaConfirm = ref(false);
export const showEditDatabasePropertiesDialog = ref(false);
export const editDatabasePropertiesLoading = ref(false);
export const editDatabasePropertiesPreviewSql = ref("");
export const editDatabaseCharset = ref("utf8mb4");
export const editDatabaseCollation = ref("utf8mb4_unicode_ci");
export const editDatabaseCommentText = ref("");
export const showEditSchemaCommentDialog = ref(false);
export const schemaCommentText = ref("");
export const schemaCommentLoading = ref(false);
export const schemaCommentPreviewSql = ref("");
export const showDeleteGroupConfirm = ref(false);
export const showMoveToNewGroupDialog = ref(false);
export const moveToNewGroupName = ref("");

const openFlags = [
  showDeleteConfirm,
  showDropTableConfirm,
  showDropTableChildObjectConfirm,
  showBatchDropConfirm,
  showBatchEmptyConfirm,
  showBatchTruncateConfirm,
  showStructurePreviewDialog,
  showStructureDocCopyDialog,
  showEmptyTableConfirm,
  showTruncateTableConfirm,
  showDropObjectConfirm,
  showRenameObjectDialog,
  showDuplicateDialog,
  showPasteDialog,
  showCreateDatabaseDialog,
  showCreateDatabasePreviewDialog,
  showCreateNacosNamespaceDialog,
  showEditNacosNamespaceDialog,
  showDropDatabaseConfirm,
  showDropMongoCollectionConfirm,
  showRenameMongoCollectionDialog,
  showDropMongoIndexConfirm,
  showDropAllMongoIndexesConfirm,
  showFlushRedisDbConfirm,
  showCreateSchemaDialog,
  showDropSchemaConfirm,
  showEditDatabasePropertiesDialog,
  showEditSchemaCommentDialog,
  showDeleteGroupConfirm,
  showMoveToNewGroupDialog,
];

export function resetSidebarTreeDialogState() {
  for (const flag of openFlags) flag.value = false;
  createDatabaseUsers.value = [];
  createDatabaseSelectedUsers.value = [];
  createDatabaseUsersLoading.value = false;
  createDatabaseAuthorizationPlan.value = undefined;
  createDatabasePreviewSql.value = "";
  createDatabaseAuthorizationResults.value = [];
  createDatabaseAuthorizationApplying.value = false;
  sidebarTreeDialogOwner.value = null;
  sidebarDangerTarget.value = null;
  sidebarFormTarget.value = null;
  connectionDeleteTargetSnapshot.value = [];
}
