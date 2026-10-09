//! Runtime scripting for SQL Server column dependencies.
//!
//! SQL Server refuses `ALTER COLUMN` while a number of catalog objects depend
//! on the column.  The schema diff model intentionally omits unchanged
//! objects, so the only complete source for those dependencies is the target
//! database itself.  This helper snapshots the supported definitions before
//! dropping anything, performs the caller-provided alteration, and restores
//! the objects in dependency order.

const DEPENDENCY_CAPTURE_AND_DROP_SQL: &str = r#"
DECLARE @dbx_qualified_table nvarchar(517) =
    QUOTENAME(OBJECT_SCHEMA_NAME(@dbx_object_id)) + N'.' + QUOTENAME(OBJECT_NAME(@dbx_object_id));

DECLARE @dbx_unsupported_index sysname;
SELECT TOP (1) @dbx_unsupported_index = idx.name
FROM sys.indexes AS idx
WHERE idx.object_id = @dbx_object_id
  AND idx.index_id > 0
  AND idx.name IS NOT NULL
  AND idx.is_hypothetical = 0
  AND idx.type NOT IN (1, 2)
  AND EXISTS (
      SELECT 1
      FROM sys.index_columns AS ic
      WHERE ic.object_id = idx.object_id
        AND ic.index_id = idx.index_id
        AND ic.column_id = @dbx_column_id
  );
IF @dbx_unsupported_index IS NOT NULL
BEGIN
    DECLARE @dbx_unsupported_index_message nvarchar(2048) =
        N'DBX cannot safely preserve affected SQL Server index ' + QUOTENAME(@dbx_unsupported_index) +
        N' because its index type is not a supported rowstore type.';
    ;THROW 50001, @dbx_unsupported_index_message, 1;
END;

IF EXISTS (
    SELECT 1
    FROM sys.indexes AS idx
    JOIN sys.data_spaces AS data_space ON data_space.data_space_id = idx.data_space_id
    WHERE idx.object_id = @dbx_object_id
      AND idx.type IN (1, 2)
      AND idx.is_hypothetical = 0
      AND data_space.type = N'PS'
      AND EXISTS (
          SELECT 1
          FROM sys.index_columns AS affected_ic
          WHERE affected_ic.object_id = idx.object_id
            AND affected_ic.index_id = idx.index_id
            AND affected_ic.column_id = @dbx_column_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM sys.index_columns AS partition_ic
          WHERE partition_ic.object_id = idx.object_id
            AND partition_ic.index_id = idx.index_id
            AND partition_ic.partition_ordinal > 0
      )
)
BEGIN
    ;THROW 50002, 'DBX could not resolve the partition column for an affected SQL Server index.', 1;
END;

DECLARE @dbx_started_transaction bit = 0;
DECLARE @dbx_has_savepoint bit = 0;

BEGIN TRY
    IF @@TRANCOUNT = 0
    BEGIN
        BEGIN TRANSACTION;
        SET @dbx_started_transaction = 1;
    END
    ELSE
    BEGIN
        SAVE TRANSACTION dbx_alter_column_dependencies;
        SET @dbx_has_savepoint = 1;
    END;

    DECLARE @dbx_dependencies TABLE (
        dependency_id int IDENTITY(1, 1) NOT NULL,
        drop_order tinyint NOT NULL,
        create_order tinyint NOT NULL,
        drop_sql nvarchar(max) NOT NULL,
        create_sql nvarchar(max) NOT NULL
    );

    -- Foreign keys are captured first and dropped before key constraints.  The
    -- predicate covers outgoing, inbound, composite, and self-referencing FKs.
    INSERT INTO @dbx_dependencies (drop_order, create_order, drop_sql, create_sql)
    SELECT
        10,
        50,
        N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id)) + N'.' +
            QUOTENAME(OBJECT_NAME(fk.parent_object_id)) + N' DROP CONSTRAINT ' + QUOTENAME(fk.name) + N';',
        N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id)) + N'.' +
            QUOTENAME(OBJECT_NAME(fk.parent_object_id)) +
            CASE WHEN fk.is_not_trusted = 1 THEN N' WITH NOCHECK' ELSE N' WITH CHECK' END +
            N' ADD CONSTRAINT ' + QUOTENAME(fk.name) + N' FOREIGN KEY (' +
            STUFF((
                SELECT N', ' + QUOTENAME(parent_column.name)
                FROM sys.foreign_key_columns AS fkc
                JOIN sys.columns AS parent_column
                  ON parent_column.object_id = fkc.parent_object_id
                 AND parent_column.column_id = fkc.parent_column_id
                WHERE fkc.constraint_object_id = fk.object_id
                ORDER BY fkc.constraint_column_id
                FOR XML PATH(''), TYPE
            ).value('.', 'nvarchar(max)'), 1, 2, N'') + N') REFERENCES ' +
            QUOTENAME(OBJECT_SCHEMA_NAME(fk.referenced_object_id)) + N'.' +
            QUOTENAME(OBJECT_NAME(fk.referenced_object_id)) + N' (' +
            STUFF((
                SELECT N', ' + QUOTENAME(referenced_column.name)
                FROM sys.foreign_key_columns AS fkc
                JOIN sys.columns AS referenced_column
                  ON referenced_column.object_id = fkc.referenced_object_id
                 AND referenced_column.column_id = fkc.referenced_column_id
                WHERE fkc.constraint_object_id = fk.object_id
                ORDER BY fkc.constraint_column_id
                FOR XML PATH(''), TYPE
            ).value('.', 'nvarchar(max)'), 1, 2, N'') + N')' +
            CASE WHEN fk.delete_referential_action_desc = N'NO_ACTION' THEN N''
                 ELSE N' ON DELETE ' + REPLACE(fk.delete_referential_action_desc, N'_', N' ') END +
            CASE WHEN fk.update_referential_action_desc = N'NO_ACTION' THEN N''
                 ELSE N' ON UPDATE ' + REPLACE(fk.update_referential_action_desc, N'_', N' ') END +
            CASE WHEN fk.is_not_for_replication = 1 THEN N' NOT FOR REPLICATION' ELSE N'' END + N'; ' +
            N'ALTER TABLE ' + QUOTENAME(OBJECT_SCHEMA_NAME(fk.parent_object_id)) + N'.' +
            QUOTENAME(OBJECT_NAME(fk.parent_object_id)) +
            CASE WHEN fk.is_disabled = 1 THEN N' NOCHECK' ELSE N' CHECK' END +
            N' CONSTRAINT ' + QUOTENAME(fk.name) + N';'
    FROM sys.foreign_keys AS fk
    WHERE EXISTS (
        SELECT 1
        FROM sys.foreign_key_columns AS fkc
        WHERE fkc.constraint_object_id = fk.object_id
          AND ((fkc.parent_object_id = @dbx_object_id AND fkc.parent_column_id = @dbx_column_id)
            OR (fkc.referenced_object_id = @dbx_object_id AND fkc.referenced_column_id = @dbx_column_id))
    );

    -- parent_column_id identifies column-level checks.  Table-level checks use
    -- expression dependencies to avoid dropping unrelated constraints.
    INSERT INTO @dbx_dependencies (drop_order, create_order, drop_sql, create_sql)
    SELECT
        20,
        40,
        N'ALTER TABLE ' + @dbx_qualified_table + N' DROP CONSTRAINT ' + QUOTENAME(cc.name) + N';',
        N'ALTER TABLE ' + @dbx_qualified_table +
            CASE WHEN cc.is_not_trusted = 1 THEN N' WITH NOCHECK' ELSE N' WITH CHECK' END +
            N' ADD CONSTRAINT ' + QUOTENAME(cc.name) + N' CHECK ' +
            CASE WHEN cc.is_not_for_replication = 1 THEN N'NOT FOR REPLICATION ' ELSE N'' END +
            cc.definition + N'; ALTER TABLE ' + @dbx_qualified_table +
            CASE WHEN cc.is_disabled = 1 THEN N' NOCHECK' ELSE N' CHECK' END +
            N' CONSTRAINT ' + QUOTENAME(cc.name) + N';'
    FROM sys.check_constraints AS cc
    WHERE cc.parent_object_id = @dbx_object_id
      AND (cc.parent_column_id = @dbx_column_id OR EXISTS (
          SELECT 1
          FROM sys.sql_expression_dependencies AS sed
          WHERE sed.referencing_id = cc.object_id
            AND sed.referenced_id = @dbx_object_id
            AND sed.referenced_minor_id = @dbx_column_id
      ));

    -- Index-owned statistics disappear with their index.  Only independent,
    -- user-created statistics need an explicit drop and recreation.
    INSERT INTO @dbx_dependencies (drop_order, create_order, drop_sql, create_sql)
    SELECT
        30,
        30,
        N'DROP STATISTICS ' + @dbx_qualified_table + N'.' + QUOTENAME(stats.name) + N';',
        N'CREATE STATISTICS ' + QUOTENAME(stats.name) + N' ON ' + @dbx_qualified_table + N' (' +
            STUFF((
                SELECT N', ' + QUOTENAME(stats_column.name)
                FROM sys.stats_columns AS sc
                JOIN sys.columns AS stats_column
                  ON stats_column.object_id = sc.object_id
                 AND stats_column.column_id = sc.column_id
                WHERE sc.object_id = stats.object_id
                  AND sc.stats_id = stats.stats_id
                ORDER BY sc.stats_column_id
                FOR XML PATH(''), TYPE
            ).value('.', 'nvarchar(max)'), 1, 2, N'') + N')' +
            CASE WHEN stats.has_filter = 1 THEN N' WHERE ' + stats.filter_definition ELSE N'' END +
            CASE WHEN stats.no_recompute = 1 THEN N' WITH NORECOMPUTE' ELSE N'' END + N';'
    FROM sys.stats AS stats
    WHERE stats.object_id = @dbx_object_id
      AND stats.user_created = 1
      AND EXISTS (
          SELECT 1
          FROM sys.stats_columns AS sc
          WHERE sc.object_id = stats.object_id
            AND sc.stats_id = stats.stats_id
            AND sc.column_id = @dbx_column_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM sys.indexes AS matching_index
          WHERE matching_index.object_id = stats.object_id
            AND matching_index.index_id = stats.stats_id
      );

    -- Ordinary clustered/nonclustered rowstore indexes.  Explicit key order,
    -- INCLUDE columns, filters, durable catalog options, data space, and the
    -- disabled state are reconstructed from the live target catalog.
    INSERT INTO @dbx_dependencies (drop_order, create_order, drop_sql, create_sql)
    SELECT
        40,
        20,
        N'DROP INDEX ' + QUOTENAME(idx.name) + N' ON ' + @dbx_qualified_table + N';',
        N'CREATE ' + CASE WHEN idx.is_unique = 1 THEN N'UNIQUE ' ELSE N'' END + idx.type_desc +
            N' INDEX ' + QUOTENAME(idx.name) + N' ON ' + @dbx_qualified_table + N' (' +
            STUFF((
                SELECT N', ' + QUOTENAME(index_column.name) +
                    CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END
                FROM sys.index_columns AS ic
                JOIN sys.columns AS index_column
                  ON index_column.object_id = ic.object_id
                 AND index_column.column_id = ic.column_id
                WHERE ic.object_id = idx.object_id
                  AND ic.index_id = idx.index_id
                  AND ic.key_ordinal > 0
                ORDER BY ic.key_ordinal
                FOR XML PATH(''), TYPE
            ).value('.', 'nvarchar(max)'), 1, 2, N'') + N')' +
            CASE WHEN EXISTS (
                SELECT 1
                FROM sys.index_columns AS include_check
                WHERE include_check.object_id = idx.object_id
                  AND include_check.index_id = idx.index_id
                  AND include_check.is_included_column = 1
            ) THEN N' INCLUDE (' + STUFF((
                SELECT N', ' + QUOTENAME(include_column.name)
                FROM sys.index_columns AS include_ic
                JOIN sys.columns AS include_column
                  ON include_column.object_id = include_ic.object_id
                 AND include_column.column_id = include_ic.column_id
                WHERE include_ic.object_id = idx.object_id
                  AND include_ic.index_id = idx.index_id
                  AND include_ic.is_included_column = 1
                ORDER BY include_ic.index_column_id
                FOR XML PATH(''), TYPE
            ).value('.', 'nvarchar(max)'), 1, 2, N'') + N')' ELSE N'' END +
            CASE WHEN idx.has_filter = 1 THEN N' WHERE ' + idx.filter_definition ELSE N'' END +
            N' WITH (PAD_INDEX = ' + CASE WHEN idx.is_padded = 1 THEN N'ON' ELSE N'OFF' END +
            CASE WHEN idx.fill_factor > 0
                 THEN N', FILLFACTOR = ' + CONVERT(nvarchar(3), idx.fill_factor)
                 ELSE N'' END +
            N', IGNORE_DUP_KEY = ' + CASE WHEN idx.ignore_dup_key = 1 THEN N'ON' ELSE N'OFF' END +
            N', STATISTICS_NORECOMPUTE = ' + CASE WHEN index_stats.no_recompute = 1 THEN N'ON' ELSE N'OFF' END +
            N', ALLOW_ROW_LOCKS = ' + CASE WHEN idx.allow_row_locks = 1 THEN N'ON' ELSE N'OFF' END +
            N', ALLOW_PAGE_LOCKS = ' + CASE WHEN idx.allow_page_locks = 1 THEN N'ON' ELSE N'OFF' END + N')' +
            CASE WHEN data_space.type = N'FG' THEN N' ON ' + QUOTENAME(data_space.name)
                 WHEN data_space.type = N'PS' THEN N' ON ' + QUOTENAME(data_space.name) + N' (' +
                      QUOTENAME((
                          SELECT TOP (1) partition_column.name
                          FROM sys.index_columns AS partition_ic
                          JOIN sys.columns AS partition_column
                            ON partition_column.object_id = partition_ic.object_id
                           AND partition_column.column_id = partition_ic.column_id
                          WHERE partition_ic.object_id = idx.object_id
                            AND partition_ic.index_id = idx.index_id
                            AND partition_ic.partition_ordinal > 0
                          ORDER BY partition_ic.partition_ordinal
                      )) + N')'
                 ELSE N'' END + N';' +
            CASE WHEN idx.is_disabled = 1 THEN N' ALTER INDEX ' + QUOTENAME(idx.name) +
                 N' ON ' + @dbx_qualified_table + N' DISABLE;' ELSE N'' END
    FROM sys.indexes AS idx
    LEFT JOIN sys.stats AS index_stats
      ON index_stats.object_id = idx.object_id
     AND index_stats.stats_id = idx.index_id
    LEFT JOIN sys.data_spaces AS data_space ON data_space.data_space_id = idx.data_space_id
    WHERE idx.object_id = @dbx_object_id
      AND idx.index_id > 0
      AND idx.name IS NOT NULL
      AND idx.type IN (1, 2)
      AND idx.is_hypothetical = 0
      AND idx.is_primary_key = 0
      AND idx.is_unique_constraint = 0
      AND EXISTS (
          SELECT 1
          FROM sys.index_columns AS affected_ic
          WHERE affected_ic.object_id = idx.object_id
            AND affected_ic.index_id = idx.index_id
            AND affected_ic.column_id = @dbx_column_id
      );

    -- PRIMARY KEY and UNIQUE constraints must be dropped/created as constraints,
    -- never as ordinary unique indexes.
    INSERT INTO @dbx_dependencies (drop_order, create_order, drop_sql, create_sql)
    SELECT
        50,
        10,
        N'ALTER TABLE ' + @dbx_qualified_table + N' DROP CONSTRAINT ' + QUOTENAME(key_constraint.name) + N';',
        N'ALTER TABLE ' + @dbx_qualified_table + N' ADD CONSTRAINT ' + QUOTENAME(key_constraint.name) + N' ' +
            CASE WHEN key_constraint.type = N'PK' THEN N'PRIMARY KEY ' ELSE N'UNIQUE ' END +
            idx.type_desc + N' (' +
            STUFF((
                SELECT N', ' + QUOTENAME(key_column.name) +
                    CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N' ASC' END
                FROM sys.index_columns AS ic
                JOIN sys.columns AS key_column
                  ON key_column.object_id = ic.object_id
                 AND key_column.column_id = ic.column_id
                WHERE ic.object_id = idx.object_id
                  AND ic.index_id = idx.index_id
                  AND ic.key_ordinal > 0
                ORDER BY ic.key_ordinal
                FOR XML PATH(''), TYPE
            ).value('.', 'nvarchar(max)'), 1, 2, N'') + N')' +
            N' WITH (PAD_INDEX = ' + CASE WHEN idx.is_padded = 1 THEN N'ON' ELSE N'OFF' END +
            CASE WHEN idx.fill_factor > 0
                 THEN N', FILLFACTOR = ' + CONVERT(nvarchar(3), idx.fill_factor)
                 ELSE N'' END +
            N', IGNORE_DUP_KEY = ' + CASE WHEN idx.ignore_dup_key = 1 THEN N'ON' ELSE N'OFF' END +
            N', STATISTICS_NORECOMPUTE = ' + CASE WHEN key_stats.no_recompute = 1 THEN N'ON' ELSE N'OFF' END +
            N', ALLOW_ROW_LOCKS = ' + CASE WHEN idx.allow_row_locks = 1 THEN N'ON' ELSE N'OFF' END +
            N', ALLOW_PAGE_LOCKS = ' + CASE WHEN idx.allow_page_locks = 1 THEN N'ON' ELSE N'OFF' END + N')' +
            CASE WHEN data_space.type = N'FG' THEN N' ON ' + QUOTENAME(data_space.name)
                 WHEN data_space.type = N'PS' THEN N' ON ' + QUOTENAME(data_space.name) + N' (' +
                      QUOTENAME((
                          SELECT TOP (1) partition_column.name
                          FROM sys.index_columns AS partition_ic
                          JOIN sys.columns AS partition_column
                            ON partition_column.object_id = partition_ic.object_id
                           AND partition_column.column_id = partition_ic.column_id
                          WHERE partition_ic.object_id = idx.object_id
                            AND partition_ic.index_id = idx.index_id
                            AND partition_ic.partition_ordinal > 0
                          ORDER BY partition_ic.partition_ordinal
                      )) + N')'
                 ELSE N'' END + N';' +
            CASE WHEN idx.is_disabled = 1 THEN N' ALTER INDEX ' + QUOTENAME(idx.name) +
                 N' ON ' + @dbx_qualified_table + N' DISABLE;' ELSE N'' END
    FROM sys.key_constraints AS key_constraint
    JOIN sys.indexes AS idx
      ON idx.object_id = key_constraint.parent_object_id
     AND idx.index_id = key_constraint.unique_index_id
    LEFT JOIN sys.stats AS key_stats
      ON key_stats.object_id = idx.object_id
     AND key_stats.stats_id = idx.index_id
    LEFT JOIN sys.data_spaces AS data_space ON data_space.data_space_id = idx.data_space_id
    WHERE key_constraint.parent_object_id = @dbx_object_id
      AND EXISTS (
          SELECT 1
          FROM sys.index_columns AS affected_ic
          WHERE affected_ic.object_id = idx.object_id
            AND affected_ic.index_id = idx.index_id
            AND affected_ic.column_id = @dbx_column_id
      );

    DECLARE @dbx_dependency_sql nvarchar(max);
    DECLARE dbx_dependency_drop_cursor CURSOR LOCAL FAST_FORWARD FOR
        SELECT drop_sql
        FROM @dbx_dependencies
        ORDER BY drop_order, dependency_id;
    OPEN dbx_dependency_drop_cursor;
    FETCH NEXT FROM dbx_dependency_drop_cursor INTO @dbx_dependency_sql;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        EXEC sys.sp_executesql @dbx_dependency_sql;
        FETCH NEXT FROM dbx_dependency_drop_cursor INTO @dbx_dependency_sql;
    END;
    CLOSE dbx_dependency_drop_cursor;
    DEALLOCATE dbx_dependency_drop_cursor;
"#;

const DEPENDENCY_RECREATE_AND_FINISH_SQL: &str = r#"
    DECLARE dbx_dependency_create_cursor CURSOR LOCAL FAST_FORWARD FOR
        SELECT create_sql
        FROM @dbx_dependencies
        ORDER BY create_order, dependency_id;
    OPEN dbx_dependency_create_cursor;
    FETCH NEXT FROM dbx_dependency_create_cursor INTO @dbx_dependency_sql;
    WHILE @@FETCH_STATUS = 0
    BEGIN
        EXEC sys.sp_executesql @dbx_dependency_sql;
        FETCH NEXT FROM dbx_dependency_create_cursor INTO @dbx_dependency_sql;
    END;
    CLOSE dbx_dependency_create_cursor;
    DEALLOCATE dbx_dependency_create_cursor;

    IF @dbx_started_transaction = 1
        COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF CURSOR_STATUS('local', 'dbx_dependency_drop_cursor') >= 0
        CLOSE dbx_dependency_drop_cursor;
    IF CURSOR_STATUS('local', 'dbx_dependency_drop_cursor') >= -1
        DEALLOCATE dbx_dependency_drop_cursor;
    IF CURSOR_STATUS('local', 'dbx_dependency_create_cursor') >= 0
        CLOSE dbx_dependency_create_cursor;
    IF CURSOR_STATUS('local', 'dbx_dependency_create_cursor') >= -1
        DEALLOCATE dbx_dependency_create_cursor;

    IF @dbx_started_transaction = 1 AND XACT_STATE() <> 0
        ROLLBACK TRANSACTION;
    ELSE IF @dbx_has_savepoint = 1 AND XACT_STATE() = 1
        ROLLBACK TRANSACTION dbx_alter_column_dependencies;

    THROW;
END CATCH;
"#;

fn escape_tsql_string_literal(value: &str) -> String {
    value.replace('\'', "''")
}

/// Build one executable T-SQL batch that preserves live dependencies around an
/// `ALTER COLUMN` operation.
///
/// `table` is the already-quoted target table name used by generated DDL (for
/// example `[dbo].[orders]`). `column_name` is the unquoted catalog name.
/// `alter_batch` may contain more than one statement, such as the existing
/// default-constraint preservation batch followed by `ALTER COLUMN`.
pub(super) fn build_dependency_aware_alter_column_batch(table: &str, column_name: &str, alter_batch: &str) -> String {
    let table_literal = escape_tsql_string_literal(table);
    let column_literal = escape_tsql_string_literal(column_name);
    let alter_batch = alter_batch.trim();

    let mut batch = String::with_capacity(
        DEPENDENCY_CAPTURE_AND_DROP_SQL.len() + DEPENDENCY_RECREATE_AND_FINISH_SQL.len() + alter_batch.len() + 512,
    );
    batch.push_str(
        "SET ANSI_NULLS ON;\n\
         SET QUOTED_IDENTIFIER ON;\n\
         SET ANSI_PADDING ON;\n\
         SET ANSI_WARNINGS ON;\n\
         SET CONCAT_NULL_YIELDS_NULL ON;\n\
         SET ARITHABORT ON;\n\
         SET NUMERIC_ROUNDABORT OFF;\n\
         DECLARE @dbx_object_id int = OBJECT_ID(N'",
    );
    batch.push_str(&table_literal);
    batch.push_str("');\nDECLARE @dbx_column_id int = COLUMNPROPERTY(@dbx_object_id, N'");
    batch.push_str(&column_literal);
    batch.push_str("', 'ColumnId');\nIF @dbx_object_id IS NULL OR @dbx_column_id IS NULL\n");
    batch.push_str("    THROW 50000, 'DBX could not resolve the SQL Server column before ALTER COLUMN.', 1;\n");
    batch.push_str(DEPENDENCY_CAPTURE_AND_DROP_SQL);
    batch.push('\n');
    batch.push_str("    ");
    batch.push_str(alter_batch);
    if !alter_batch.ends_with(';') {
        batch.push(';');
    }
    batch.push('\n');
    batch.push_str(DEPENDENCY_RECREATE_AND_FINISH_SQL);
    batch
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_batch_escapes_catalog_literals_and_keeps_alter_sql() {
        let sql = build_dependency_aware_alter_column_batch(
            "[odd].[O'Brien]",
            "amount's value",
            "ALTER TABLE [odd].[O'Brien] ALTER COLUMN [amount's value] bigint NULL;",
        );

        assert!(sql.contains("OBJECT_ID(N'[odd].[O''Brien]')"), "{sql}");
        assert!(sql.contains("COLUMNPROPERTY(@dbx_object_id, N'amount''s value', 'ColumnId')"), "{sql}");
        assert!(sql.contains("ALTER TABLE [odd].[O'Brien] ALTER COLUMN [amount's value] bigint NULL;"), "{sql}");
    }

    #[test]
    fn dependency_batch_covers_every_supported_dependency_kind() {
        let sql = build_dependency_aware_alter_column_batch(
            "[dbo].[orders]",
            "amount",
            "ALTER TABLE [dbo].[orders] ALTER COLUMN [amount] bigint NOT NULL;",
        );

        for catalog in [
            "sys.foreign_keys AS fk",
            "sys.foreign_key_columns AS fkc",
            "sys.check_constraints AS cc",
            "sys.sql_expression_dependencies AS sed",
            "sys.stats_columns AS sc",
            "sys.indexes AS idx",
            "sys.key_constraints AS key_constraint",
        ] {
            assert!(sql.contains(catalog), "missing {catalog}: {sql}");
        }

        assert!(sql.contains("fkc.referenced_object_id = @dbx_object_id"), "inbound FK predicate: {sql}");
        assert!(sql.contains("ORDER BY fkc.constraint_column_id"), "composite FK order: {sql}");
        assert!(sql.contains("fk.delete_referential_action_desc"), "delete action: {sql}");
        assert!(sql.contains("fk.update_referential_action_desc"), "update action: {sql}");
        assert!(sql.contains("fk.is_not_for_replication"), "NFR state: {sql}");
        assert!(sql.contains("fk.is_not_trusted"), "trust state: {sql}");
        assert!(sql.contains("fk.is_disabled"), "enabled state: {sql}");
        assert!(sql.contains("stats.user_created = 1"), "independent statistics: {sql}");
        assert!(sql.contains("stats.no_recompute"), "statistics options: {sql}");
        assert!(sql.contains("ic.is_descending_key"), "index key order: {sql}");
        assert!(sql.contains("include_ic.is_included_column = 1"), "included columns: {sql}");
        assert!(sql.contains("idx.filter_definition"), "filtered index: {sql}");
        assert!(sql.contains("idx.allow_row_locks"), "index options: {sql}");
        assert!(sql.contains("data_space.type = N'PS'"), "partition data space: {sql}");
        assert!(sql.contains("idx.is_disabled = 1"), "disabled index state: {sql}");
        assert!(sql.contains("key_constraint.type = N'PK'"), "primary key form: {sql}");
        assert!(sql.contains("THEN N'PRIMARY KEY ' ELSE N'UNIQUE ' END"), "PK/UQ distinction: {sql}");
    }

    #[test]
    fn dependency_batch_rejects_unsupported_indexes_before_dropping_anything() {
        let sql = build_dependency_aware_alter_column_batch(
            "[dbo].[events]",
            "payload",
            "ALTER TABLE [dbo].[events] ALTER COLUMN [payload] varbinary(max) NULL;",
        );

        let guard = sql.find("idx.type NOT IN (1, 2)").expect("unsupported-index guard");
        let rejection = sql.find("THROW 50001").expect("unsupported-index THROW");
        let drop_cursor = sql.find("dbx_dependency_drop_cursor CURSOR").expect("drop cursor");
        assert!(guard < rejection && rejection < drop_cursor, "guard must run before every dependency drop: {sql}");
    }

    #[test]
    fn dependency_batch_is_atomic_and_recreates_after_the_alter() {
        let alter = "ALTER TABLE [dbo].[metrics] ALTER COLUMN [value] decimal(18,2) NOT NULL;";
        let sql = build_dependency_aware_alter_column_batch("[dbo].[metrics]", "value", alter);

        let drop_cursor = sql.find("dbx_dependency_drop_cursor CURSOR").expect("drop cursor");
        let alter_position = sql.find(alter).expect("alter statement");
        let create_cursor = sql.find("dbx_dependency_create_cursor CURSOR").expect("create cursor");
        assert!(drop_cursor < alter_position && alter_position < create_cursor, "drop/alter/create order: {sql}");
        assert!(sql.contains("BEGIN TRY"), "{sql}");
        assert!(sql.starts_with("SET ANSI_NULLS ON;\nSET QUOTED_IDENTIFIER ON;"), "{sql}");
        assert!(sql.contains("SAVE TRANSACTION dbx_alter_column_dependencies"), "{sql}");
        assert!(sql.contains("ROLLBACK TRANSACTION dbx_alter_column_dependencies"), "{sql}");
        assert!(sql.contains("IF @dbx_started_transaction = 1\n        COMMIT TRANSACTION"), "{sql}");
        assert!(sql.contains("THROW;\nEND CATCH"), "{sql}");
    }

    #[test]
    fn dependency_batch_terminates_an_unterminated_alter_batch_once() {
        let sql = build_dependency_aware_alter_column_batch(
            "[dbo].[metrics]",
            "value",
            "ALTER TABLE [dbo].[metrics] ALTER COLUMN [value] bigint NULL",
        );
        assert!(sql.contains("ALTER TABLE [dbo].[metrics] ALTER COLUMN [value] bigint NULL;\n"), "{sql}");
        assert!(!sql.contains("bigint NULL;;"), "{sql}");
    }
}
