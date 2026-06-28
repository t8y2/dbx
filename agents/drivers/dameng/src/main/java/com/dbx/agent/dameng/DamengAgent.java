package com.dbx.agent.dameng;

import com.dbx.agent.BaseDatabaseAgent;
import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.DatabaseInfo;
import com.dbx.agent.ExecuteQueryOptions;
import com.dbx.agent.ForeignKeyInfo;
import com.dbx.agent.IndexInfo;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.JdbcIdentifiers;
import com.dbx.agent.JsonRpcServer;
import com.dbx.agent.ObjectInfo;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.QueryPageOptions;
import com.dbx.agent.QueryPageResult;
import com.dbx.agent.QueryResult;
import com.dbx.agent.TableInfo;
import com.dbx.agent.TriggerInfo;
import java.io.PrintStream;
import java.sql.Blob;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLXML;
import java.sql.Statement;
import java.sql.Types;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class DamengAgent extends BaseDatabaseAgent {
    private static final String AGENT_VERSION = "9999.06.04.1-fix-default";
    private static final Set<String> SYSTEM_USERS = Set.of(
        "SYS", "SYSAUDITOR", "SYSSSO", "CTISYS",
        "SYS_DBA", "_SYS_STATISTICS", "SYS_PHM"
    );

    private Connection connection;
    private String connectedUsername;

    @Override
    public Connection getConnection() {
        return connection;
    }

    @Override
    public void connect(ConnectParams params) {
        uncheckedVoid(() -> {
            withSuppressedStdout(() -> {
                Class.forName("dm.jdbc.driver.DmDriver");
                connection = DriverManager.getConnection(buildUrl(params), params.getUsername(), params.getPassword());
                connectedUsername = params.getUsername();
            });
        });
    }

    @Override
    public boolean testConnection(ConnectParams params) {
        return unchecked(() -> {
            return withSuppressedStdout(() -> {
                Class.forName("dm.jdbc.driver.DmDriver");
                try (Connection conn = DriverManager.getConnection(buildUrl(params), params.getUsername(), params.getPassword())) {
                    return conn.isValid(5);
                }
            });
        });
    }

    /**
     * The DM JDBC driver writes a banner to {@code System.out} during
     * {@code Class.forName} / driver initialization.  This corrupts the
     * JSON-RPC stdout protocol.  Temporarily redirect {@code System.out}
     * to {@code System.err} so driver output lands on stderr instead.
     */
    private static <T> T withSuppressedStdout(ThrowingSupplier<T> action) throws Exception {
        PrintStream originalOut = System.out;
        try {
            System.setOut(System.err);
            return action.get();
        } finally {
            System.setOut(originalOut);
        }
    }

    private static void withSuppressedStdout(ThrowingRunnable action) throws Exception {
        PrintStream originalOut = System.out;
        try {
            System.setOut(System.err);
            action.run();
        } finally {
            System.setOut(originalOut);
        }
    }

    @Override
    public List<DatabaseInfo> listDatabases() {
        return unchecked(() -> {
            List<DatabaseInfo> result = new ArrayList<>();
            String placeholders = String.join(",", SYSTEM_USERS.stream().map(user -> "?").toList());
            String sql = "SELECT USERNAME FROM ALL_USERS WHERE USERNAME NOT IN (" + placeholders + ") ORDER BY USERNAME";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                int index = 1;
                for (String user : SYSTEM_USERS) {
                    stmt.setString(index++, user);
                }
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new DatabaseInfo(rs.getString(1)));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<String> listSchemas() {
        return unchecked(() -> {
            List<String> result = new ArrayList<>();
            String sql = "SELECT DISTINCT OWNER FROM ALL_OBJECTS ORDER BY OWNER";
            try (java.sql.Statement stmt = requireConnected().createStatement();
                 ResultSet rs = stmt.executeQuery(sql)) {
                while (rs.next()) {
                    result.add(rs.getString(1));
                }
            }
            return result;
        });
    }

    @Override
    public List<TableInfo> listTables(String schema) {
        return listTables(schema, null);
    }

    @Override
    public List<TableInfo> listTables(String schema, List<String> objectTypes) {
        return unchecked(() -> {
            Map<String, TableInfo> tablesByName = new LinkedHashMap<>();
            if (objectTypesInclude(objectTypes, "TABLE")) {
                loadTableOrView(schema, "TABLE", tablesByName);
            }
            if (objectTypesInclude(objectTypes, "VIEW")) {
                loadTableOrView(schema, "VIEW", tablesByName);
            }
            if (objectTypesInclude(objectTypes, "MATERIALIZED_VIEW")) {
                loadMaterializedViews(schema, tablesByName);
            }
            List<TableInfo> result = new ArrayList<>(tablesByName.values());
            result.sort(Comparator.comparing(TableInfo::getName));
            return result;
        });
    }

    private void loadTableOrView(String schema, String tableType, Map<String, TableInfo> tablesByName) {
        if (!loadTableOrViewFromAllObjects(schema, tableType, tablesByName)) {
            loadTableOrViewFromComments(schema, tableType, tablesByName);
        }
        if ("VIEW".equals(tableType)) {
            removeMaterializedViewsFromRegularViews(schema, tablesByName);
        }
    }

    private boolean loadTableOrViewFromAllObjects(String schema, String tableType, Map<String, TableInfo> tablesByName) {
        String sql = ("""
            SELECT o.OBJECT_NAME AS TABLE_NAME, c.COMMENTS
            FROM ALL_OBJECTS o
            LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = o.OBJECT_NAME
            WHERE o.OWNER = ? AND o.OBJECT_TYPE = '%s' AND ( (o.OBJECT_TYPE = 'TABLE' AND o.OBJECT_NAME NOT LIKE 'MTAB$_%%') OR o.OBJECT_TYPE = 'VIEW')
            ORDER BY o.OBJECT_NAME
            """).formatted(tableType).stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    addTableInfo(tablesByName, rs.getString(1), tableType, rs.getString(2));
                }
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void loadTableOrViewFromComments(String schema, String tableType, Map<String, TableInfo> tablesByName) {
        String tableNameFilter = "TABLE".equals(tableType) ? " AND TABLE_NAME NOT LIKE 'MTAB$_%'" : "";
        String sql = ("""
            SELECT TABLE_NAME, COMMENTS
            FROM ALL_TAB_COMMENTS
            WHERE OWNER = ? AND TABLE_TYPE = '%s'%s
            ORDER BY TABLE_NAME
            """).formatted(tableType, tableNameFilter).stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    addTableInfo(tablesByName, rs.getString(1), tableType, rs.getString(2));
                }
            }
        } catch (Exception ignored) {
            // Keep metadata browsing usable even when optional catalog views are restricted.
        }
    }

    private void loadMaterializedViews(String schema, Map<String, TableInfo> tablesByName) {
        loadMaterializedViewsFromAllObjects(schema, tablesByName);
    }

    private void loadMaterializedViewsFromAllObjects(String schema, Map<String, TableInfo> tablesByName) {
        String sql = """
            SELECT m.MVIEW_NAME AS TABLE_NAME, c.COMMENTS
			FROM USER_MVIEWS m LEFT JOIN ALL_OBJECTS o ON m.SCHID = o.OBJECT_ID
			LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER = o.OWNER AND c.TABLE_NAME = m.MVIEW_NAME
			WHERE o.OWNER = ?
			ORDER BY TABLE_NAME
            """.stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    addTableInfo(tablesByName, rs.getString(1), "MATERIALIZED_VIEW", rs.getString(2));
                }
            }
        } catch (Exception ignored) {
            // Older or restricted Dameng catalogs may not expose this object type.
        }
    }

    private void loadMaterializedViewsFromUserMviews(String schema, Map<String, TableInfo> tablesByName) {
        if (!schemaMatchesConnectedUser(schema)) {
            return;
        }
        loadUserMviews("SELECT MVIEW_NAME FROM USER_MVIEWS", tablesByName);
    }

    private boolean loadUserMviews(String sql, Map<String, TableInfo> tablesByName) {
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql);
             ResultSet rs = stmt.executeQuery()) {
            while (rs.next()) {
                addTableInfo(tablesByName, rs.getString(1), "MATERIALIZED_VIEW", null);
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private void removeMaterializedViewsFromRegularViews(String schema, Map<String, TableInfo> tablesByName) {
        /*if (!schemaMatchesConnectedUser(schema)) {
            return;
        }*/
        for (String name : listUserMviewNames()) {
            tablesByName.remove(name);
        }
    }

    private Set<String> listUserMviewNames() {
        Set<String> names = new java.util.HashSet<>();
        String sql = "SELECT MVIEW_NAME FROM USER_MVIEWS";
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql);
             ResultSet rs = stmt.executeQuery()) {
            while (rs.next()) {
                String key = metadataNameKey(rs.getString(1));
                if (!key.isEmpty()) {
                    names.add(key);
                }
            }
        } catch (Exception ignored) {
            // Some Dameng versions or users do not expose USER_MVIEWS.
        }
        return names;
    }

    private boolean schemaMatchesConnectedUser(String schema) {
        return connectedUsername != null
            && schema != null
            && !connectedUsername.isBlank()
            && schema.equalsIgnoreCase(connectedUsername);
    }

    private static void addTableInfo(Map<String, TableInfo> tablesByName, String name, String tableType, String comment) {
        String key = metadataNameKey(name);
        if (!key.isEmpty()) {
            tablesByName.put(key, new TableInfo(name, tableType, comment));
        }
    }

    private static boolean objectTypesInclude(List<String> objectTypes, String expectedType) {
        if (objectTypes == null || objectTypes.isEmpty()) {
            return true;
        }
        for (String objectType : objectTypes) {
            if (expectedType.equals(normalizeObjectType(objectType))) {
                return true;
            }
        }
        return false;
    }

    private static String normalizeObjectType(String value) {
        String upper = value == null ? "" : value.trim().toUpperCase(Locale.ROOT).replace(' ', '_').replace('-', '_');
        if (upper.contains("MATERIALIZED") && upper.contains("VIEW")) {
            return "MATERIALIZED_VIEW";
        }
        if (upper.contains("VIEW")) {
            return "VIEW";
        }
        if (upper.contains("TABLE")) {
            return "TABLE";
        }
        return upper;
    }

    private static String metadataNameKey(String value) {
        return value == null ? "" : value.trim().toUpperCase(Locale.ROOT);
    }

    @Override
    public List<ObjectInfo> listObjects(String schema) {
        return unchecked(() -> {
            List<ObjectInfo> result = new ArrayList<>();
            for (TableInfo table : listTables(schema)) {
                result.add(new ObjectInfo(table.getName(), table.getTable_type(), schema, table.getComment()));
            }
            String sql = """
                SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS
                WHERE OWNER = ? AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')
                ORDER BY CASE OBJECT_TYPE WHEN 'PROCEDURE' THEN 0 ELSE 1 END, OBJECT_NAME
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ObjectInfo(rs.getString(1), rs.getString(2), schema, null));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        return unchecked(() -> {
            String dbmsType = switch (objectType.toUpperCase(Locale.ROOT)) {
                case "VIEW" -> "VIEW";
                case "MATERIALIZED_VIEW", "MATERIALIZED VIEW" -> "MATERIALIZED_VIEW";
                case "PROCEDURE" -> "PROCEDURE";
                case "FUNCTION" -> "FUNCTION";
                default -> throw new IllegalArgumentException("Unsupported object type: " + objectType);
            };
            String source;
            String sql = "SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, dbmsType);
                stmt.setString(2, name);
                stmt.setString(3, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    source = rs.next() ? coalesce(rs.getString(1)) : "";
                }
            }
            return new ObjectSource(name, objectType, schema, source);
        });
    }

    @Override
    public String getTableDdl(String schema, String table) {
        return unchecked(() -> {
            String sql = "SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL";
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, "TABLE");
                stmt.setString(2, table);
                stmt.setString(3, schema);
                try (ResultSet rs = stmt.executeQuery()) {
                    if (rs.next()) {
                        return appendTableAndColumnComments(coalesce(rs.getString(1)), schema, table);
                    }
                }
            }
            throw new IllegalArgumentException("Table not found: " + schema + "." + table);
        });
    }

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        return unchecked(() -> {
            Set<String> pkColumns = new java.util.HashSet<>();
            String pkSql = """
                SELECT cols.COLUMN_NAME FROM ALL_CONS_COLUMNS cols
                JOIN ALL_CONSTRAINTS cons ON cols.CONSTRAINT_NAME = cons.CONSTRAINT_NAME AND cols.OWNER = cons.OWNER
                WHERE cons.CONSTRAINT_TYPE = 'P' AND cons.OWNER = ? AND cons.TABLE_NAME = ?
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(pkSql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        pkColumns.add(rs.getString(1));
                    }
                }
            }

            Set<String> identityColumns = identityColumns(schema, table);
            List<ColumnInfo> result = new ArrayList<>();
            // DATA_DEFAULT is a LONG column — it must be selected first and read first
            // in JDBC, otherwise the data is truncated.
            String colSql = """
                SELECT c.DATA_DEFAULT,
                    c.COLUMN_NAME,
                    c.DATA_TYPE,
                    c.NULLABLE,
                    c.DATA_PRECISION,
                    c.DATA_SCALE,
                    c.DATA_LENGTH,
                    c.CHAR_LENGTH,
                    cc.COMMENTS
                FROM ALL_TAB_COLUMNS c
                LEFT JOIN ALL_COL_COMMENTS cc
                    ON cc.OWNER = c.OWNER
                    AND cc.TABLE_NAME = c.TABLE_NAME
                    AND cc.COLUMN_NAME = c.COLUMN_NAME
                WHERE c.OWNER = ? AND c.TABLE_NAME = ?
                ORDER BY c.COLUMN_ID
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(colSql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        // DATA_DEFAULT is a LONG — must be read first, before all other columns.
                        String dataDefault = readLongColumn(rs, "DATA_DEFAULT");
                        String name = rs.getString("COLUMN_NAME");
                        String baseType = rs.getString("DATA_TYPE");
                        Integer numPrec = intObject(rs, "DATA_PRECISION");
                        Integer numScale = intObject(rs, "DATA_SCALE");
                        Integer dataLen = intObject(rs, "DATA_LENGTH");
                        Integer charLen = intObject(rs, "CHAR_LENGTH");
                        String dataType = formatDataType(baseType, numPrec, numScale, dataLen, charLen);

                        result.add(new ColumnInfo(
                            name,
                            dataType,
                            "Y".equals(rs.getString("NULLABLE")),
                            dataDefault,
                            pkColumns.contains(name),
                            identityColumns.contains(name) ? "identity" : null,
                            rs.getString("COMMENTS"),
                            numPrec,
                            numScale,
                            charLen
                        ));
                    }
                }
            }
            fillMissingColumnComments(schema, table, result);
            return result;
        });
    }

    private Set<String> identityColumns(String schema, String table) {
        Set<String> result = new java.util.HashSet<>();
        String sql = """
            SELECT c.NAME
            FROM SYS.SYSCOLUMNS c
            JOIN SYS.SYSOBJECTS t ON c.ID = t.ID
            JOIN SYS.SYSOBJECTS s ON t.SCHID = s.ID
            WHERE s.NAME = ? AND t.NAME = ? AND (c.INFO2 & 0x01) = 0x01
            """.stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, table);
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String column = rs.getString(1);
                    if (notBlank(column)) {
                        result.add(column);
                    }
                }
            }
        } catch (Exception ignored) {
            // Some Dameng versions or users do not expose SYS.SYSCOLUMNS.
        }
        return result;
    }

    @Override
    public List<IndexInfo> listIndexes(String schema, String table) {
        return unchecked(() -> {
            List<IndexInfo> result = new ArrayList<>();
            String sql = """
                SELECT i.INDEX_NAME,
                    LISTAGG(ic.COLUMN_NAME, ',') WITHIN GROUP (ORDER BY ic.COLUMN_POSITION) AS COLUMNS,
                    i.UNIQUENESS,
                    CASE WHEN c.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PK,
                    i.INDEX_TYPE
                FROM ALL_INDEXES i
                JOIN ALL_IND_COLUMNS ic ON i.INDEX_NAME = ic.INDEX_NAME AND i.OWNER = ic.INDEX_OWNER AND i.TABLE_OWNER = ic.TABLE_OWNER
                LEFT JOIN ALL_CONSTRAINTS c ON i.INDEX_NAME = c.INDEX_NAME AND i.TABLE_OWNER = c.OWNER
                    AND c.CONSTRAINT_TYPE = 'P'
                WHERE i.TABLE_OWNER = ? AND i.TABLE_NAME = ?
                GROUP BY i.INDEX_NAME, i.UNIQUENESS, c.CONSTRAINT_TYPE, i.INDEX_TYPE
                ORDER BY i.INDEX_NAME
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new IndexInfo(
                            rs.getString(1),
                            splitNonEmpty(coalesce(rs.getString(2)), ","),
                            "UNIQUE".equals(rs.getString(3)),
                            "1".equals(rs.getString(4)),
                            null,
                            rs.getString(5),
                            null,
                            null
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<ForeignKeyInfo> listForeignKeys(String schema, String table) {
        return unchecked(() -> {
            List<ForeignKeyInfo> result = new ArrayList<>();
            String sql = """
                SELECT c.CONSTRAINT_NAME, cc.COLUMN_NAME, rc.TABLE_NAME, rcc.COLUMN_NAME
                FROM ALL_CONSTRAINTS c
                JOIN ALL_CONS_COLUMNS cc ON c.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND c.OWNER = cc.OWNER
                JOIN ALL_CONSTRAINTS rc ON c.R_CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND c.R_OWNER = rc.OWNER
                JOIN ALL_CONS_COLUMNS rcc ON rc.CONSTRAINT_NAME = rcc.CONSTRAINT_NAME AND rc.OWNER = rcc.OWNER
                WHERE c.CONSTRAINT_TYPE = 'R' AND c.OWNER = ? AND c.TABLE_NAME = ?
                ORDER BY c.CONSTRAINT_NAME
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new ForeignKeyInfo(
                            rs.getString(1),
                            rs.getString(2),
                            rs.getString(3),
                            rs.getString(4)
                        ));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public List<TriggerInfo> listTriggers(String schema, String table) {
        return unchecked(() -> {
            List<TriggerInfo> result = new ArrayList<>();
            String sql = """
                SELECT TRIGGER_NAME, TRIGGERING_EVENT, '' AS TRIGGER_TYPE
                FROM ALL_TRIGGERS
                WHERE OWNER = ? AND TABLE_NAME = ?
                ORDER BY TRIGGER_NAME
                """.stripIndent().trim();
            try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
                stmt.setString(1, schema);
                stmt.setString(2, table);
                try (ResultSet rs = stmt.executeQuery()) {
                    while (rs.next()) {
                        result.add(new TriggerInfo(rs.getString(1), rs.getString(2), rs.getString(3)));
                    }
                }
            }
            return result;
        });
    }

    @Override
    public QueryResult executeQuery(String sql, String schema, ExecuteQueryOptions options) {
        return JdbcExecutor.INSTANCE.execute(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options.getMaxRows(),
            options.getFetchSize(),
            options.getTimeoutSecs(),
            this::stringResultValue
        );
    }

    @Override
    public QueryPageResult executeQueryPage(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.INSTANCE.executePage(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options,
            this::stringResultValue
        );
    }

    @Override
    public QueryPageResult startTableRead(String sql, String schema, QueryPageOptions options) {
        return JdbcExecutor.INSTANCE.startTableRead(
            requireConnected(),
            sql,
            schema,
            this::setSchemaSQL,
            options,
            this::stringResultValue
        );
    }

    @Override
    public String setSchemaSQL(String schema) {
        return "SET SCHEMA " + JdbcIdentifiers.INSTANCE.doubleQuote(schema);
    }

    @Override
    public void disconnect() {
        uncheckedVoid(() -> {
            if (connection != null) {
                connection.close();
            }
            connection = null;
        });
    }

    private Object stringResultValue(ResultSet rs, int index, int sqlType) {
        return unchecked(() -> {
            Object value = switch (sqlType) {
                case Types.BIGINT -> rs.getLong(index);
                case Types.INTEGER, Types.SMALLINT, Types.TINYINT -> rs.getInt(index);
                case Types.FLOAT, Types.REAL -> rs.getFloat(index);
                case Types.DOUBLE -> rs.getDouble(index);
                case Types.DECIMAL, Types.NUMERIC -> rs.getBigDecimal(index);
                case Types.BOOLEAN, Types.BIT -> rs.getBoolean(index);
                case Types.CHAR, Types.VARCHAR, Types.LONGVARCHAR,
                    Types.NCHAR, Types.NVARCHAR, Types.LONGNVARCHAR,
                    Types.CLOB, Types.NCLOB -> rs.getString(index);
                case Types.BINARY, Types.VARBINARY, Types.LONGVARBINARY,
                    Types.BLOB -> bytesToHex(rs.getBytes(index));
                case Types.SQLXML -> sqlXmlToString(rs.getSQLXML(index));
                default -> normalizeResultValue(rs.getObject(index));
            };
            return rs.wasNull() ? null : value;
        });
    }

    private static Object normalizeResultValue(Object value) {
        if (value == null) return null;
        if (value instanceof Clob) {
            Clob clob = (Clob) value;
            return unchecked(() -> clob.getSubString(1, Math.toIntExact(clob.length())));
        }
        if (value instanceof Blob) {
            Blob blob = (Blob) value;
            return unchecked(() -> bytesToHex(blob.getBytes(1, Math.toIntExact(blob.length()))));
        }
        if (value instanceof SQLXML) {
            SQLXML sqlxml = (SQLXML) value;
            return unchecked(sqlxml::getString);
        }
        if (value instanceof byte[]) {
            return bytesToHex((byte[]) value);
        }
        return value instanceof Number || value instanceof Boolean ? value : value.toString();
    }

    private static String sqlXmlToString(SQLXML value) {
        return value == null ? null : unchecked(value::getString);
    }

    private static String bytesToHex(byte[] bytes) {
        if (bytes == null) {
            return null;
        }
        StringBuilder result = new StringBuilder(bytes.length * 2 + 2);
        result.append("0x");
        for (byte b : bytes) {
            result.append(Character.forDigit((b >> 4) & 0xF, 16));
            result.append(Character.forDigit(b & 0xF, 16));
        }
        return result.toString();
    }

    private static String buildUrl(ConnectParams params) {
        String database = params.getDatabase() == null ? "" : params.getDatabase().trim();
        String suffix = database.isEmpty() ? "" : "/" + database;
        return "jdbc:dm://" + params.getHost() + ":" + params.getPort() + suffix;
    }

    private static String formatDataType(String base, Integer numPrec, Integer numScale, Integer dataLen, Integer charLen) {
        return switch (base.toUpperCase(Locale.ROOT)) {
            case "VARCHAR2", "NVARCHAR2", "VARCHAR", "CHAR", "NCHAR" -> {
                Integer length = charLen != null ? charLen : dataLen;
                yield length != null ? base + "(" + length + ")" : base;
            }
            case "NUMBER", "NUMERIC", "DECIMAL" -> {
                if (numPrec != null && numScale != null && numScale > 0) {
                    yield base + "(" + numPrec + "," + numScale + ")";
                }
                yield numPrec != null && numPrec > 0 ? base + "(" + numPrec + ")" : base;
            }
            case "RAW" -> dataLen != null ? "RAW(" + dataLen + ")" : "RAW";
            default -> base;
        };
    }

    private static Integer intObject(ResultSet rs, String column) throws Exception {
        Object value = rs.getObject(column);
        return value == null ? null : ((Number) value).intValue();
    }

    // DATA_DEFAULT is stored as a LONG column in Oracle/Dameng. JDBC requires LONG
    // columns to be read before other columns. We also try getCharacterStream as a
    // fallback because some drivers don't support getString on LONG columns.
    private static String readLongColumn(ResultSet rs, String column) throws Exception {
        try {
            String value = rs.getString(column);
            if (value != null) {
                return value;
            }
        } catch (Exception ignored) {
        }
        try (java.io.Reader reader = rs.getCharacterStream(column)) {
            if (reader == null) {
                return null;
            }
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[4096];
            int n;
            while ((n = reader.read(buf)) != -1) {
                sb.append(buf, 0, n);
            }
            return sb.toString();
        }
    }

    private static List<String> splitNonEmpty(String value, String delimiter) {
        List<String> result = new ArrayList<>();
        Arrays.stream(value.split(delimiter))
            .filter(part -> !part.isEmpty())
            .forEach(result::add);
        return result;
    }

    private static String coalesce(String value) {
        return value == null ? "" : value;
    }

    private void fillMissingColumnComments(String schema, String table, List<ColumnInfo> columns) {
        if (columns.stream().noneMatch(column -> !notBlank(column.getComment()))) {
            return;
        }
        Map<String, String> comments = new HashMap<>();
        queryColumnComments(
            comments,
            "SELECT COLUMN_NAME, COMMENTS FROM USER_COL_COMMENTS WHERE TABLE_NAME = ?",
            table
        );
        queryColumnComments(
            comments,
            "SELECT COLNAME, COMMENT$ FROM SYS.SYSCOLUMNCOMMENTS WHERE SCHNAME = ? AND TVNAME = ?",
            schema,
            table
        );
        queryColumnComments(
            comments,
            "SELECT COLUMN_NAME, COMMENTS FROM ALL_COL_COMMENTS WHERE UPPER(OWNER) = UPPER(?) AND UPPER(TABLE_NAME) = UPPER(?)",
            schema,
            table
        );
        for (ColumnInfo column : columns) {
            if (notBlank(column.getComment())) {
                continue;
            }
            String comment = comments.get(column.getName().toUpperCase(Locale.ROOT));
            if (notBlank(comment)) {
                column.setComment(comment);
            }
        }
    }

    private void queryColumnComments(Map<String, String> comments, String sql, String... params) {
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            for (int i = 0; i < params.length; i++) {
                stmt.setString(i + 1, params[i]);
            }
            try (ResultSet rs = stmt.executeQuery()) {
                while (rs.next()) {
                    String column = rs.getString(1);
                    String comment = rs.getString(2);
                    if (notBlank(column) && notBlank(comment)) {
                        comments.putIfAbsent(column.toUpperCase(Locale.ROOT), comment);
                    }
                }
            }
        } catch (Exception ignored) {
            // Some Dameng versions or users do not expose every comment view.
        }
    }

    private String appendTableAndColumnComments(String ddl, String schema, String table) throws Exception {
        StringBuilder result = new StringBuilder(ddl == null ? "" : ddl.trim());
        String tableRef = qualifiedName(schema, table);
        String tableComment = tableComment(schema, table);
        if (notBlank(tableComment) && !containsCommentOnTable(result.toString(), schema, table)) {
            appendCommentStatement(result, "COMMENT ON TABLE " + tableRef + " IS '" + sqlStringBody(tableComment) + "';");
        }
        for (ColumnInfo column : getColumns(schema, table)) {
            if (!notBlank(column.getComment()) || containsCommentOnColumn(result.toString(), schema, table, column.getName())) {
                continue;
            }
            appendCommentStatement(result, "COMMENT ON COLUMN " + tableRef + "." + JdbcIdentifiers.INSTANCE.doubleQuote(column.getName()) + " IS '" + sqlStringBody(column.getComment()) + "';");
        }
        return result.toString();
    }

    private String tableComment(String schema, String table) throws Exception {
        String sql = """
            SELECT COMMENTS
            FROM ALL_TAB_COMMENTS
            WHERE OWNER = ? AND TABLE_NAME = ?
            """.stripIndent().trim();
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setString(1, schema);
            stmt.setString(2, table);
            try (ResultSet rs = stmt.executeQuery()) {
                return rs.next() ? rs.getString(1) : null;
            }
        }
    }

    private static void appendCommentStatement(StringBuilder ddl, String statement) {
        if (!ddl.isEmpty()) {
            if (ddl.charAt(ddl.length() - 1) != '\n') {
                ddl.append("\n");
            }
            ddl.append("\n");
        }
        ddl.append(statement);
    }

    private static boolean containsCommentOnTable(String ddl, String schema, String table) {
        return normalizedDdl(ddl).contains("COMMENT ON TABLE " + normalizedQualifiedName(schema, table));
    }

    private static boolean containsCommentOnColumn(String ddl, String schema, String table, String column) {
        return normalizedDdl(ddl).contains("COMMENT ON COLUMN " + normalizedQualifiedName(schema, table) + "." + normalizedIdentifier(column));
    }

    private static String qualifiedName(String schema, String name) {
        if (!notBlank(schema)) {
            return JdbcIdentifiers.INSTANCE.doubleQuote(name);
        }
        return JdbcIdentifiers.INSTANCE.doubleQuote(schema) + "." + JdbcIdentifiers.INSTANCE.doubleQuote(name);
    }

    private static String normalizedQualifiedName(String schema, String name) {
        if (!notBlank(schema)) {
            return normalizedIdentifier(name);
        }
        return normalizedIdentifier(schema) + "." + normalizedIdentifier(name);
    }

    private static String normalizedIdentifier(String value) {
        return JdbcIdentifiers.INSTANCE.doubleQuote(value).toUpperCase(Locale.ROOT);
    }

    private static String normalizedDdl(String ddl) {
        return coalesce(ddl).toUpperCase(Locale.ROOT).replaceAll("\\s+", " ");
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static String sqlStringBody(String value) {
        return value.replace("'", "''");
    }

    @Override
    public String getExplainInfo(String sql, String database, String schema, int timeoutSecs, String mode) {
        return unchecked(() -> {
            Connection conn = requireConnected();
            boolean autotrace = "autotrace".equalsIgnoreCase(mode);
            String planText = null;

            if (autotrace) {
                boolean monitorEnabled = false;
                try (Statement s = conn.createStatement()) {
                    s.execute("SF_SET_SESSION_PARA_VALUE('MONITOR_SQL_EXEC', 1)");
                    monitorEnabled = true;
                } catch (Exception ignored) {}

                try (Statement stmt = conn.createStatement()) {
                    if (timeoutSecs >= 0) {
                        try { stmt.setQueryTimeout(timeoutSecs); } catch (Exception ignored) {}
                    }
                    boolean hasResultSet = stmt.execute(sql);
                    if (hasResultSet) {
                        try (ResultSet rs = stmt.getResultSet()) {
                            while (rs.next()) { /* consume all rows */ }
                        }
                    }
                    try {
                        Class<?> dmConnClass = Class.forName("dm.jdbc.driver.DmdbConnection");
                        if (dmConnClass.isInstance(conn)) {
                            Method m = dmConnClass.getMethod("getExplainInfo", Statement.class);
                            planText = (String) m.invoke(dmConnClass.cast(conn), stmt);
                        }
                    } catch (Exception ignored) {}
                } finally {
                    if (monitorEnabled) {
                        try (Statement s = conn.createStatement()) {
                            s.execute("SF_SET_SESSION_PARA_VALUE('MONITOR_SQL_EXEC', 0)");
                        } catch (Exception ignored) {}
                    }
                }
            } else {
                try {
                    Class<?> dmConnClass = Class.forName("dm.jdbc.driver.DmdbConnection");
                    if (dmConnClass.isInstance(conn)) {
                        Method m = dmConnClass.getMethod("getExplainInfo", String.class);
                        planText = (String) m.invoke(dmConnClass.cast(conn), sql);
                    }
                } catch (Exception ignored) {}
            }

            if (planText == null || planText.trim().isEmpty()) {
                try (Statement explainStmt = conn.createStatement();
                     ResultSet rs = explainStmt.executeQuery("EXPLAIN " + sql)) {
                    StringBuilder sb = new StringBuilder();
                    while (rs.next()) {
                        sb.append(rs.getString(1)).append("\n");
                    }
                    planText = sb.toString().trim();
                } catch (Exception ignored) {}
            }
            return planText != null ? planText : "";
        });
    }

    public static void main(String[] args) {
        new JsonRpcServer(new DamengAgent()).run();
    }
}
