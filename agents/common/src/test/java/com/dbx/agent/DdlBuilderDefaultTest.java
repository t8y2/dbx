package com.dbx.agent;

import java.util.List;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

class DdlBuilderDefaultTest {

    @Test
    void nulFreeDefaultsPassThroughUnchanged() {
        ColumnInfo padded = new ColumnInfo("padded", "INTEGER", true, " 42 ", false);
        String ddl = DdlBuilder.buildTableDdl("root", "test_table", List.of(padded), List.of(), List.of());
        Assertions.assertFalse(ddl.contains("\0"), "DDL must not contain NUL bytes");
        Assertions.assertTrue(ddl.contains("DEFAULT  42 "), "NUL-free defaults must not be trimmed");
    }

    @Test
    void nulTruncatedDefaultsAreTrimmedAndDroppedWhenEmpty() {
        ColumnInfo padded = new ColumnInfo("padded", "INTEGER", true, " 42 \0pad", false);
        ColumnInfo empty = new ColumnInfo("empty_default", "INTEGER", true, "\0junk", false);
        String ddl = DdlBuilder.buildTableDdl("root", "test_table", List.of(padded, empty), List.of(), List.of());
        Assertions.assertTrue(ddl.contains("DEFAULT 42"));
        Assertions.assertFalse(ddl.contains("DEFAULT pad"));
        Assertions.assertTrue(ddl.contains("\"empty_default\" INTEGER"));
        Assertions.assertFalse(ddl.contains("\"empty_default\" INTEGER NOT NULL DEFAULT"));
    }

    @Test
    void keyDirectionsRenderIntoPrimaryKeyAndSecondaryIndexes() {
        IndexInfo primaryKey = new IndexInfo(
            "PRIMARY_KEY", List.of("a", "b"), true, true,
            null, null, null, null, null
        );
        primaryKey.setKey_directions(List.of("ASC", "DESC"));
        IndexInfo secondary = new IndexInfo(
            "idx_lookup", List.of("slip_number", "slip_input_date"), true, false,
            null, null, null, null, null
        );
        secondary.setKey_directions(List.of("DESC", "DESC"));
        IndexInfo ascendingOnly = new IndexInfo(
            "idx_created", List.of("customer_id", "created_at"), false, false,
            null, null, null, null, null
        );
        ascendingOnly.setKey_directions(List.of("asc", "ASC"));

        String ddl = DdlBuilder.buildTableDdl(
            "root", "orders", List.of(), List.of(primaryKey, secondary, ascendingOnly), List.of()
        );

        Assertions.assertTrue(ddl.contains("PRIMARY KEY (\"a\", \"b\" DESC)"), ddl);
        Assertions.assertTrue(ddl.contains("(\"slip_number\" DESC, \"slip_input_date\" DESC)"), ddl);
        Assertions.assertTrue(ddl.contains("(\"customer_id\", \"created_at\")"), ddl);
        Assertions.assertFalse(ddl.contains(" ASC"), "ASC is the default and must stay implicit: " + ddl);
    }
}
