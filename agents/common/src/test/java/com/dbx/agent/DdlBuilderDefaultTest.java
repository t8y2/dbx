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
}
