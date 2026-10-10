export interface OracleTypeIdentity {
  schema: string;
  name: string;
  object_type: "TYPE" | "TYPE_BODY";
}

export type OracleMetadataReadState = "available" | "empty" | "unknown" | "unsupported" | "denied" | "error";

export interface OracleMetadataSection<T> {
  state: OracleMetadataReadState;
  rows: T[];
  message?: string;
}

export interface OracleTypeDetails {
  identity: OracleTypeIdentity;
  status: string | null;
  paired_object: OracleTypeIdentity | null;
  pairing_state: OracleMetadataReadState;
  dependencies: OracleMetadataSection<{
    schema: string;
    name: string;
    object_type: string;
    referenced_schema: string | null;
    referenced_name: string;
    referenced_type: string;
    referenced_link: string | null;
    dependency_type: string | null;
  }>;
  grants: OracleMetadataSection<{
    grantor: string | null;
    grantee: string;
    privilege: string;
    grantable: boolean | null;
  }>;
}
