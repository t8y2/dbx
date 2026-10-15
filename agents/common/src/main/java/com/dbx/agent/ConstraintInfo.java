package com.dbx.agent;

import java.util.List;

/** Shared wire shape; null state properties mean the database did not report them. */
public record ConstraintInfo(
    String name, String constraint_type, String definition, List<String> columns,
    Boolean deferrable, Boolean initially_deferred, Boolean enabled, Boolean valid,
    OracleConstraintMetadata oracle_metadata
) {
    public ConstraintInfo(
        String name, String constraint_type, String definition, List<String> columns,
        Boolean deferrable, Boolean initially_deferred, Boolean enabled, Boolean valid
    ) {
        this(name, constraint_type, definition, columns, deferrable, initially_deferred, enabled, valid, null);
    }

    public record OracleConstraintMetadata(
        boolean metadataComplete, String owner, String constraintType, String status, String validated,
        String deferrable, String deferred, String rely, String indexOwner, String indexName,
        String indexSharing, OracleConstraintIndexMetadata index
    ) {}

    public record OracleConstraintIndexMetadata(
        boolean metadataComplete, String owner, String tableOwner, String tableName, String indexType,
        String uniqueness, String status, boolean partitioned, String visibility, String secondary,
        List<String> columns, List<String> directions, List<Boolean> keyIsExpression, List<String> includedColumns
    ) {}
}
