package com.dbx.agent.saphana;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.test.TestSupport;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class SapHanaAgentDdlTest {
    @Test
    void includesColumnCommentsVisibleInReportedTableMetadata() {
        MetadataFixture metadata = new MetadataFixture("CRMAI_P02", "ET_DATA");
        metadata.tableComment = "管家婆同步过来的终端主数据";
        metadata.columns.add(column("ID", "BIGINT", null, "id"));
        metadata.columns.get(0).put("NULLABLE", DatabaseMetaData.columnNoNulls);
        metadata.primaryKeys.add(row("COLUMN_NAME", "ID"));
        String[] names = {
            "DATA_SOURCE", "ET_ID", "TERMINAL_NAME", "TERMINAL_ADDRESS", "DEALER_CODE", "DEALER_NAME",
            "APPROVE_STATUS", "APPROVE_ID", "APPROVE_REMARK", "PARTNER", "DELETE_FLAG", "CREATE_BY",
            "CREATE_NAME", "CREATE_TIME", "UPDATE_BY", "UPDATE_NAME", "UPDATE_TIME", "REGION"
        };
        Integer[] sizes = {50, 100, 40, 100, 10, 40, 2, 50, 1000, 20, 1, 255, 255, null, 255, 255, null, 14};
        String[] comments = {
            "数据来源，管家婆，其他系统", "外部系统终端ID", "终端名称", "终端地址", "经销商编码，在CRM系统中存在", "经销商名称"
        };
        for (int index = 0; index < names.length; index++) {
            metadata.columns.add(column(
                names[index], sizes[index] == null ? "TIMESTAMP" : "NVARCHAR", sizes[index],
                index < comments.length ? comments[index] : null
            ));
        }
        SapHanaAgent agent = metadata.agent();
        List<ColumnInfo> columns = agent.getColumns(metadata.schema, metadata.table);
        assertEquals(19, columns.size());
        assertEquals("id", columns.get(0).getComment());
        for (int index = 0; index < comments.length; index++) {
            assertEquals(comments[index], columns.get(index + 1).getComment());
        }
        metadata.calls.clear();

        String ddl = agent.getTableDdl(metadata.schema, metadata.table);

        String originalDdl = "CREATE TABLE \"CRMAI_P02\".\"ET_DATA\" (\n"
            + "  \"ID\" BIGINT NOT NULL,\n"
            + "  \"DATA_SOURCE\" NVARCHAR(50),\n"
            + "  \"ET_ID\" NVARCHAR(100),\n"
            + "  \"TERMINAL_NAME\" NVARCHAR(40),\n"
            + "  \"TERMINAL_ADDRESS\" NVARCHAR(100),\n"
            + "  \"DEALER_CODE\" NVARCHAR(10),\n"
            + "  \"DEALER_NAME\" NVARCHAR(40),\n"
            + "  \"APPROVE_STATUS\" NVARCHAR(2),\n"
            + "  \"APPROVE_ID\" NVARCHAR(50),\n"
            + "  \"APPROVE_REMARK\" NVARCHAR(1000),\n"
            + "  \"PARTNER\" NVARCHAR(20),\n"
            + "  \"DELETE_FLAG\" NVARCHAR(1),\n"
            + "  \"CREATE_BY\" NVARCHAR(255),\n"
            + "  \"CREATE_NAME\" NVARCHAR(255),\n"
            + "  \"CREATE_TIME\" TIMESTAMP,\n"
            + "  \"UPDATE_BY\" NVARCHAR(255),\n"
            + "  \"UPDATE_NAME\" NVARCHAR(255),\n"
            + "  \"UPDATE_TIME\" TIMESTAMP,\n"
            + "  \"REGION\" NVARCHAR(14),\n"
            + "  PRIMARY KEY (\"ID\")\n);\n"
            + "\nCOMMENT ON TABLE \"CRMAI_P02\".\"ET_DATA\" IS '管家婆同步过来的终端主数据';";
        StringBuilder expected = new StringBuilder(originalDdl);
        expected.append("\nCOMMENT ON COLUMN \"CRMAI_P02\".\"ET_DATA\".\"ID\" IS 'id';");
        for (int index = 0; index < comments.length; index++) {
            expected.append("\nCOMMENT ON COLUMN \"CRMAI_P02\".\"ET_DATA\".\"")
                .append(names[index]).append("\" IS '").append(comments[index]).append("';");
        }
        assertEquals(expected.toString(), ddl);
        metadata.assertSingleMetadataRead();
    }

    @Test
    void reusesStandardEscapingForIdentifiersAndUnicodeMultilineComments() {
        MetadataFixture metadata = new MetadataFixture("S\"模式", "T\"表");
        metadata.tableComment = "表's\n说明";
        metadata.columns.add(column("C\"列", "NVARCHAR", 50, "  用户's 数据\n第二行\r\n終端 🚀  "));

        assertEquals(
            "CREATE TABLE \"S\"\"模式\".\"T\"\"表\" (\n  \"C\"\"列\" NVARCHAR(50)\n);\n"
                + "\nCOMMENT ON TABLE \"S\"\"模式\".\"T\"\"表\" IS '表''s\n说明';"
                + "\nCOMMENT ON COLUMN \"S\"\"模式\".\"T\"\"表\".\"C\"\"列\" IS '  用户''s 数据\n第二行\r\n終端 🚀  ';",
            metadata.ddl()
        );
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "\t\r\n"})
    void omitsBlankColumnCommentsWithoutLosingTableComments(String comment) {
        MetadataFixture metadata = new MetadataFixture("APP", "ITEMS");
        metadata.tableComment = "table only";
        metadata.columns.add(column("ID", "INTEGER", null, comment));

        assertEquals(
            "CREATE TABLE \"APP\".\"ITEMS\" (\n  \"ID\" INTEGER\n);\n"
                + "\nCOMMENT ON TABLE \"APP\".\"ITEMS\" IS 'table only';",
            metadata.ddl()
        );
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {" ", "\t\r\n"})
    void includesColumnCommentsWithoutATableComment(String comment) {
        MetadataFixture metadata = new MetadataFixture("APP", "ITEMS");
        metadata.tableComment = comment;
        metadata.columns.add(column("ID", "INTEGER", null, "column only"));

        assertEquals(
            "CREATE TABLE \"APP\".\"ITEMS\" (\n  \"ID\" INTEGER\n);\n"
                + "\nCOMMENT ON COLUMN \"APP\".\"ITEMS\".\"ID\" IS 'column only';",
            metadata.ddl()
        );
    }

    @ParameterizedTest
    @NullAndEmptySource
    void supportsUnqualifiedTables(String schema) {
        MetadataFixture metadata = new MetadataFixture(schema, "ITEMS");
        metadata.columns.add(column("ID", "INTEGER", null, "identifier"));

        assertEquals(
            "CREATE TABLE \"ITEMS\" (\n  \"ID\" INTEGER\n);\n"
                + "\nCOMMENT ON COLUMN \"ITEMS\".\"ID\" IS 'identifier';",
            metadata.ddl()
        );
    }

    @Test
    void preservesTypesDefaultsPrimaryKeysIndexesAndForeignKeys() {
        MetadataFixture metadata = relatedTable();

        assertEquals(
            "CREATE TABLE \"APP\".\"ITEMS\" (\n"
                + "  \"ID\" BIGINT NOT NULL DEFAULT 7,\n"
                + "  \"SOURCE\" NVARCHAR(50) DEFAULT 'ERP',\n"
                + "  \"PRICE\" DECIMAL(12, 2) DEFAULT 0.00,\n"
                + "  \"ACTIVE\" BOOLEAN DEFAULT TRUE,\n"
                + "  \"CREATED_AT\" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,\n"
                + "  PRIMARY KEY (\"ID\"),\n"
                + "  CONSTRAINT \"FK_SOURCE\" FOREIGN KEY (\"SOURCE\", \"ID\") REFERENCES \"PARENT\"(\"CODE\", \"ID\")\n);\n"
                + "\nCOMMENT ON COLUMN \"APP\".\"ITEMS\".\"ID\" IS 'identifier';"
                + "\nCREATE UNIQUE INDEX \"UQ_SOURCE\" ON \"APP\".\"ITEMS\" (\"SOURCE\", \"ID\");"
                + "\nCREATE INDEX \"IX_PRICE\" ON \"APP\".\"ITEMS\" (\"PRICE\");",
            metadata.ddl()
        );
    }

    @ParameterizedTest
    @ValueSource(strings = {"getIndexInfo", "getImportedKeys", "getTables", "getPrimaryKeys", "allOptional"})
    void keepsOptionalMetadataFailureFallbacks(String failure) {
        MetadataFixture metadata = relatedTable();
        metadata.tableComment = "table comment";
        metadata.failures = "allOptional".equals(failure)
            ? List.of("getIndexInfo", "getImportedKeys", "getTables", "getPrimaryKeys")
            : List.of(failure);

        String ddl = metadata.ddl();

        assertTrue(ddl.contains("\"ID\" BIGINT NOT NULL DEFAULT 7"));
        assertTrue(ddl.contains("COMMENT ON COLUMN \"APP\".\"ITEMS\".\"ID\" IS 'identifier';"));
        assertEquals(!metadata.failures.contains("getIndexInfo"), ddl.contains("CREATE UNIQUE INDEX \"UQ_SOURCE\""));
        assertEquals(!metadata.failures.contains("getImportedKeys"), ddl.contains("CONSTRAINT \"FK_SOURCE\""));
        assertEquals(!metadata.failures.contains("getTables"), ddl.contains("COMMENT ON TABLE"));
        assertEquals(!"allOptional".equals(failure), ddl.contains("PRIMARY KEY (\"ID\")"));
    }

    @Test
    void propagatesColumnMetadataFailureInsteadOfReturningIncompleteDdl() {
        MetadataFixture metadata = relatedTable();
        metadata.failures = List.of("getColumns");

        RuntimeException error = assertThrows(RuntimeException.class, metadata::ddl);

        assertEquals("metadata unavailable: getColumns", error.getCause().getMessage());
        metadata.assertSingleMetadataRead();
    }

    @Test
    void preservesEmptyColumnMetadataResult() {
        MetadataFixture metadata = new MetadataFixture("APP", "ITEMS");

        assertEquals("CREATE TABLE \"APP\".\"ITEMS\" (\n\n);\n", metadata.ddl());
    }

    private static MetadataFixture relatedTable() {
        MetadataFixture metadata = new MetadataFixture("APP", "ITEMS");
        metadata.columns.add(column("ID", "BIGINT", null, "identifier"));
        metadata.columns.get(0).putAll(row("NULLABLE", DatabaseMetaData.columnNoNulls, "COLUMN_DEF", "7"));
        metadata.columns.add(column("SOURCE", "NVARCHAR", 50, null));
        metadata.columns.get(1).put("COLUMN_DEF", "'ERP'");
        metadata.columns.add(column("PRICE", "DECIMAL", 12, null));
        metadata.columns.get(2).putAll(row("DECIMAL_DIGITS", 2, "COLUMN_DEF", "0.00"));
        metadata.columns.add(column("ACTIVE", "BOOLEAN", null, null));
        metadata.columns.get(3).put("COLUMN_DEF", "TRUE");
        metadata.columns.add(column("CREATED_AT", "TIMESTAMP", null, null));
        metadata.columns.get(4).put("COLUMN_DEF", "CURRENT_TIMESTAMP");
        metadata.primaryKeys.add(row("COLUMN_NAME", "ID"));
        metadata.indexes.add(row("INDEX_NAME", "PRIMARY", "COLUMN_NAME", "ID", "ORDINAL_POSITION", 1));
        metadata.indexes.add(row("INDEX_NAME", "UQ_SOURCE", "COLUMN_NAME", "ID", "ORDINAL_POSITION", 2));
        metadata.indexes.add(row("INDEX_NAME", "UQ_SOURCE", "COLUMN_NAME", "SOURCE", "ORDINAL_POSITION", 1));
        metadata.indexes.add(row(
            "INDEX_NAME", "IX_PRICE", "COLUMN_NAME", "PRICE", "NON_UNIQUE", true, "ORDINAL_POSITION", 1
        ));
        metadata.foreignKeys.add(row(
            "FK_NAME", "FK_SOURCE", "FKCOLUMN_NAME", "SOURCE", "PKTABLE_NAME", "PARENT", "PKCOLUMN_NAME", "CODE"
        ));
        metadata.foreignKeys.add(row(
            "FK_NAME", "FK_SOURCE", "FKCOLUMN_NAME", "ID", "PKTABLE_NAME", "PARENT", "PKCOLUMN_NAME", "ID"
        ));
        return metadata;
    }

    private static Map<String, Object> column(String name, String type, Integer size, String comment) {
        return row(
            "COLUMN_NAME", name, "TYPE_NAME", type, "COLUMN_SIZE", size,
            "NULLABLE", DatabaseMetaData.columnNullable, "REMARKS", comment
        );
    }

    private static Map<String, Object> row(Object... values) {
        Map<String, Object> row = new LinkedHashMap<>();
        for (int index = 0; index < values.length; index += 2) {
            row.put((String) values[index], values[index + 1]);
        }
        return row;
    }

    private static final class MetadataFixture {
        private final String schema;
        private final String table;
        private final List<Map<String, Object>> columns = new ArrayList<>();
        private final List<Map<String, Object>> primaryKeys = new ArrayList<>();
        private final List<Map<String, Object>> indexes = new ArrayList<>();
        private final List<Map<String, Object>> foreignKeys = new ArrayList<>();
        private final Map<String, Integer> calls = new LinkedHashMap<>();
        private List<String> failures = List.of();
        private String tableComment;

        private MetadataFixture(String schema, String table) {
            this.schema = schema;
            this.table = table;
        }

        private SapHanaAgent agent() {
            DatabaseMetaData metadata = proxy(DatabaseMetaData.class, (method, args) -> {
                String name = method.getName();
                if (List.of("getColumns", "getPrimaryKeys", "getIndexInfo", "getImportedKeys", "getTables").contains(name)) {
                    calls.merge(name, 1, Integer::sum);
                    assertNull(args[0]);
                    if (!"getTables".equals(name)) {
                        assertEquals(schema == null || schema.isEmpty() ? null : schema, args[1]);
                        assertEquals(table, args[2]);
                    }
                }
                if (failures.contains(name)) {
                    throw new SQLException("metadata unavailable: " + name);
                }
                switch (name) {
                    case "getColumns": return resultSet(columns);
                    case "getPrimaryKeys": return resultSet(primaryKeys);
                    case "getIndexInfo": return resultSet(indexes);
                    case "getImportedKeys": return resultSet(foreignKeys);
                    case "getTableTypes": return resultSet(List.of(row("TABLE_TYPE", "COLUMN TABLE")));
                    case "getTables": return resultSet(List.of(row(
                        "TABLE_NAME", table, "TABLE_TYPE", "COLUMN TABLE", "REMARKS", tableComment
                    )));
                    case "getSearchStringEscape": return "\\";
                    default: throw new AssertionError("Unexpected metadata call: " + name);
                }
            });
            Connection connection = proxy(Connection.class, (method, args) -> {
                switch (method.getName()) {
                    case "getMetaData": return metadata;
                    case "isClosed": return false;
                    default: throw new AssertionError("Unexpected connection call: " + method.getName());
                }
            });
            SapHanaAgent agent = new SapHanaAgent();
            TestSupport.setPrivateConnection(agent, connection);
            return agent;
        }

        private String ddl() {
            String ddl = agent().getTableDdl(schema, table);
            assertSingleMetadataRead();
            return ddl;
        }

        private void assertSingleMetadataRead() {
            assertEquals(
                Map.of("getColumns", 1, "getPrimaryKeys", 1, "getIndexInfo", 1, "getImportedKeys", 1, "getTables", 1),
                calls
            );
        }
    }

    private static ResultSet resultSet(List<Map<String, Object>> rows) {
        int[] cursor = {-1};
        return proxy(ResultSet.class, (method, args) -> {
            switch (method.getName()) {
                case "next": return ++cursor[0] < rows.size();
                case "close": return null;
                case "getString":
                case "getObject": return rows.get(cursor[0]).get(args[0]);
                case "getBoolean": return Boolean.TRUE.equals(rows.get(cursor[0]).get(args[0]));
                case "getInt": return ((Number) rows.get(cursor[0]).getOrDefault(args[0], 0)).intValue();
                case "getShort": return ((Number) rows.get(cursor[0]).getOrDefault(args[0], 0)).shortValue();
                default: throw new AssertionError("Unexpected result set call: " + method.getName());
            }
        });
    }

    private static <T> T proxy(Class<T> type, Handler handler) {
        return type.cast(Proxy.newProxyInstance(
            type.getClassLoader(), new Class<?>[]{type},
            (proxy, method, args) -> handler.handle(method, args)
        ));
    }

    @FunctionalInterface
    private interface Handler {
        Object handle(Method method, Object[] args) throws Throwable;
    }
}
