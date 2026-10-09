export interface PrimaryKeyChange {
  schema: string;
  tableName: string;
  columns: string[];
  dropPreviousIndex?: boolean;
}

export interface CheckDefinition {
  name: string;
  expression: string;
  enabled: boolean;
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  rely: boolean;
}
export interface UniqueDefinition {
  name: string;
  columns: string[];
  enabled: boolean;
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  rely: boolean;
}
export interface CheckChange {
  schema: string;
  tableName: string;
  originalName: string | null;
  desired: CheckDefinition | null;
}
export interface CheckChangePreview extends Omit<ConstraintChangePreview, "currentConstraint"> {
  currentConstraint: CheckDefinition | null;
}
export interface CheckChangeResult extends Omit<ConstraintChangeResult, "currentConstraint"> {
  currentConstraint: CheckDefinition | null;
  originalConstraint: CheckDefinition | null;
}
export interface UniqueSnapshot extends UniqueDefinition {
  indexOwner: string | null;
  indexName: string | null;
}
export interface UniqueChange {
  schema: string;
  tableName: string;
  originalName: string | null;
  desired: UniqueDefinition | null;
  dropPreviousIndex: boolean;
}
export interface UniqueChangePreview extends Omit<ConstraintChangePreview, "currentConstraint"> {
  currentConstraint: UniqueSnapshot | null;
}
export interface UniqueChangeResult extends Omit<ConstraintChangeResult, "currentConstraint"> {
  currentConstraint: UniqueSnapshot | null;
  originalConstraint: UniqueSnapshot | null;
}

export interface ForeignKeyDefinition {
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  deleteRule: "NO ACTION" | "CASCADE" | "SET NULL";
  rely: boolean;
  enabled: boolean;
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
}

export interface ForeignKeyChange {
  schema: string;
  tableName: string;
  originalName: string | null;
  desired: ForeignKeyDefinition | null;
}

export interface ForeignKeyChangePreview extends Omit<ConstraintChangePreview, "currentConstraint"> {
  currentConstraint: ForeignKeyDefinition | null;
}

export interface ForeignKeyChangeResult extends Omit<ConstraintChangeResult, "currentConstraint"> {
  currentConstraint: ForeignKeyDefinition | null;
  originalConstraint: ForeignKeyDefinition | null;
}

export interface KeySnapshot {
  name: string;
  columns: string[];
  enabled: boolean;
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  indexOwner: string | null;
  indexName: string | null;
}

export interface ConstraintChangePreview {
  statements: string[];
  revision: string;
  currentConstraint: KeySnapshot | null;
  affectedObjects: string[];
  recoveryStatements: string[];
}

export interface ConstraintChangeResult {
  success: boolean;
  steps: { sql: string; success: boolean; error: string | null }[];
  currentConstraint: KeySnapshot | null;
  refreshError: string | null;
  recoveryStatements: string[];
}
