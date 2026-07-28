export interface ConfigAuditEntry {
  id: string;
  timestamp: string;
  operator: string;
  reason: string;
  keyPath: string;
  changeDiff: unknown;
  configSnapshot: unknown;
}

export interface ConfigVersionSnapshot {
  id: string;
  keyPath: string;
  version: number;
  snapshotJson: unknown;
  checksum: string;
  createdAt: string;
}

export interface AuditQuery {
  keyPath?: string;
  operator?: string;
  limit?: number;
  offset?: number;
}

export interface AuditSummary {
  totalEntries: number;
  entries: ConfigAuditEntry[];
}

export type ApprovalStatus = "draft" | "pending_approval" | "approved" | "rejected";

export interface ApprovalRecord {
  id: string;
  configDomain: string;
  changeDescription: string;
  status: ApprovalStatus;
  requester: string;
  reviewer?: string;
  reviewedAt?: string;
  webhookUrl?: string;
  draftConfigJson: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface DriftAlert {
  id: string;
  sourceEnv: string;
  targetEnv: string;
  configKey: string;
  expectedChecksum: string;
  actualChecksum: string;
  detailsJson: unknown;
  detectedAt: string;
  acknowledged: boolean;
}

export interface DriftReport {
  sourceEnv: string;
  targetEnv: string;
  keyPath: string;
  sourceChecksum: string;
  targetChecksum: string;
  mismatchedFields: string[];
  sourceChangedAt?: string;
  detectedAt: string;
}

export type DdlRiskLevel = "safe" | "caution" | "dangerous" | "blocked";

export type ExecStrategy = "online" | "lazy" | "offline" | "batch";

export interface LockInfo {
  lockType: string;
  objects: string[];
  duration: string;
}

export interface ImpactReport {
  overallRisk: DdlRiskLevel;
  ddlRiskLevel: DdlRiskLevel;
  estimatedLocks: LockInfo[];
  estimatedTotalDuration: string;
  recommendedStrategy: ExecStrategy;
  warnings: string[];
  requiresMaintenanceWindow: boolean;
  isReversible: boolean;
}

export type OscExecutionStatus = "preparing" | "copying" | "cut_over" | "completed" | "failed" | "postponed";

export interface OscStatus {
  toolType: "gh-ost" | "pt-osc";
  tableName: string;
  status: OscExecutionStatus;
  progressPercent: number;
  estimatedRemainingSecs?: number;
  error?: string;
}

export type DegradationLevel = "full" | "sample" | "skip_with_risk";

export interface BusinessTag {
  key: string;
  value: string;
  description: string;
  immutable: boolean;
}

export interface ConflictItem {
  objectName: string;
  conflictType: string;
  sourceValue: string;
  targetValue: string;
  autoResolvable: boolean;
}

export interface RebasePlan {
  id: string;
  baselineId: string;
  conflicts: ConflictItem[];
  totalObjects: number;
  autoResolvedCount: number;
  createdAt: string;
}

export interface ConfigDriftSummary {
  sourceEnv: string;
  targetEnv: string;
  driftCount: number;
  lastDetectedAt: string;
  hasUnacknowledged: boolean;
}
