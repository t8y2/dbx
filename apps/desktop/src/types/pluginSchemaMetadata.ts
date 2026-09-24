/**
 * Read-only Plugin Host schema metadata contract (#9917).
 *
 * The request reuses the canonical `PluginTableContext` from the table tree;
 * this file only defines the narrow response returned by the host. It does not
 * expose DBX's internal `ColumnInfo`, comments, keys, credentials or SQL.
 */

import type { PluginTableContext } from "@/types/database";

export type { PluginTableContext } from "@/types/database";

/** Permission required by `host.getTableMetadata`. */
export const PLUGIN_SCHEMA_METADATA_PERMISSION = "host.schema:read";

/** Capability advertised by the bridge when the backend adapter is present. */
export const PLUGIN_SCHEMA_METADATA_CAPABILITY = "schemaMetadataApi";

/** Mirrors the Rust-side identifier bound for the plugin metadata request. */
export const MAX_PLUGIN_SCHEMA_METADATA_NAME_CHARS = 256;

export type PluginMetadataFieldAvailability = "supported" | "unsupported" | "unknown";

export interface PluginTableMetadata {
  columns: PluginColumnMetadata[];
  /** Conservative provider provenance for optional structured fields. */
  fieldCapabilities: PluginMetadataFieldCapabilities;
}

export interface PluginColumnMetadata {
  name: string;
  dataType: string;
  nullable: boolean;
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
  default?: string | null;
}

export interface PluginMetadataFieldCapabilities {
  length: PluginMetadataFieldAvailability;
  precision: PluginMetadataFieldAvailability;
  scale: PluginMetadataFieldAvailability;
  default: PluginMetadataFieldAvailability;
}

export type PluginTableMetadataRequest = PluginTableContext;
