package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Date;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.DriverPropertyInfo;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Properties;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.logging.Logger;

public final class DbxJdbcPlugin {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final int MAX_ROWS = 10_000;
    private static final JdbcDriverQuirks DEFAULT_QUIRKS = new JdbcDriverQuirks(false, false);
    private static final JdbcDriverQuirks YASHAN_QUIRKS = new JdbcDriverQuirks(true, true);
    private static final JdbcDriverQuirks ORACLE_QUIRKS = new JdbcDriverQuirks(false, true);
    private static final List<JdbcDriverQuirkRule> DRIVER_QUIRK_RULES = List.of(
        new JdbcDriverQuirkRule("jdbc:yasdb:", YASHAN_QUIRKS),
        new JdbcDriverQuirkRule("jdbc:oracle:", ORACLE_QUIRKS)
    );
    private static String registeredDriverKey = "";
    private static String sharedConnectionKey = "";
    private static Connection sharedConnection;

    record JdbcDriverQuirks(boolean skipExecutionContext, boolean useOracleMetadata) {
    }

    private record JdbcDriverQuirkRule(String urlPrefix, JdbcDriverQuirks quirks) {
    }

    private DbxJdbcPlugin() {
    }

    public static void main(String[] args) throws Exception {
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.isBlank()) {
                    continue;
                }
                ObjectNode response = handleLine(line);
                System.out.println(MAPPER.writeValueAsString(response));
                System.out.flush();
                if (response.path("_dbx_close").asBoolean(false)) {
                    break;
                }
            }
        } finally {
            closeSharedConnection();
        }
    }

    private static ObjectNode handleLine(String line) throws Exception {
        JsonNode request = MAPPER.readTree(line);
        JsonNode id = request.path("id");
        ObjectNode response = MAPPER.createObjectNode();
        response.set("id", id.isMissingNode() ? MAPPER.getNodeFactory().numberNode(1) : id);

        try {
            String method = requireText(request, "method");
            JsonNode params = request.path("params");
            JsonNode connection = params.path("connection");
            if ("close".equals(method)) {
                closeSharedConnection();
                ObjectNode result = MAPPER.createObjectNode();
                result.put("ok", true);
                response.set("result", result);
                response.put("_dbx_close", true);
                return response;
            }
            registerDrivers(connection);
            response.set("result", handle(method, params, connection));
        } catch (Exception error) {
            ObjectNode errorNode = MAPPER.createObjectNode();
            errorNode.put("message", error.getMessage() == null ? error.toString() : error.getMessage());
            response.set("error", errorNode);
        }
        return response;
    }

    private static JsonNode handle(String method, JsonNode params, JsonNode connection) throws Exception {
        return switch (method) {
            case "testConnection", "connect" -> {
                openConnection(connection);
                ObjectNode result = MAPPER.createObjectNode();
                result.put("ok", true);
                yield result;
            }
            case "executeQuery" -> executeQuery(
                connection,
                requireText(params, "sql"),
                optionalText(params, "database"),
                optionalText(params, "schema")
            );
            case "listDatabases" -> listDatabases(connection);
            case "listSchemas" -> listSchemas(connection, optionalText(params, "database"));
            case "listTables" -> listTables(connection, optionalText(params, "database"), optionalText(params, "schema"));
            case "listObjects", "list_objects" -> listObjects(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema")
            );
            case "getColumns" -> getColumns(
                connection,
                optionalText(params, "database"),
                optionalText(params, "schema"),
                requireText(params, "table")
            );
            default -> throw new IllegalArgumentException("Unsupported JDBC plugin method: " + method);
        };
    }

    private static void registerDrivers(JsonNode connection) throws Exception {
        String driverKey = driverKey(connection);
        if (driverKey.equals(registeredDriverKey)) {
            return;
        }
        List<URL> urls = new ArrayList<>();
        JsonNode paths = connection.path("jdbc_driver_paths");
        if (paths.isArray()) {
            for (JsonNode path : paths) {
                String value = path.asText("").trim();
                if (!value.isEmpty()) {
                    urls.add(expandHome(value).toUri().toURL());
                }
            }
        }

        ClassLoader loader = urls.isEmpty()
            ? Thread.currentThread().getContextClassLoader()
            : new URLClassLoader(urls.toArray(URL[]::new), DbxJdbcPlugin.class.getClassLoader());
        Thread.currentThread().setContextClassLoader(loader);

        String driverClass = optionalText(connection, "jdbc_driver_class");
        if (driverClass != null) {
            Driver driver = (Driver) Class.forName(driverClass, true, loader).getDeclaredConstructor().newInstance();
            DriverManager.registerDriver(new DriverShim(driver));
            registeredDriverKey = driverKey;
            return;
        }

        boolean loaded = false;
        for (Driver driver : ServiceLoader.load(Driver.class, loader)) {
            DriverManager.registerDriver(new DriverShim(driver));
            loaded = true;
        }
        if (!loaded && !urls.isEmpty()) {
            throw new IllegalArgumentException("No JDBC driver was discovered. Enter the driver class name for this JAR.");
        }
        registeredDriverKey = driverKey;
    }

    private static Connection openConnection(JsonNode connection) throws SQLException {
        String url = optionalText(connection, "connection_string");
        if (url == null) {
            throw new IllegalArgumentException("JDBC URL is required.");
        }
        String key = connectionKey(connection);
        if (sharedConnection != null && key.equals(sharedConnectionKey) && !sharedConnection.isClosed()) {
            return sharedConnection;
        }
        closeSharedConnection();

        Properties properties = new Properties();
        String username = optionalText(connection, "username");
        String password = optionalText(connection, "password");
        if (username != null) {
            properties.setProperty("user", username);
        }
        if (password != null) {
            properties.setProperty("password", password);
        }
        if (isOracleUrl(url)) {
            properties.putIfAbsent("remarksReporting", "false");
            properties.putIfAbsent("restrictGetTables", "true");
            properties.putIfAbsent("includeSynonyms", "false");
            properties.putIfAbsent("oracle.jdbc.defaultRowPrefetch", "100");
        }
        sharedConnection = DriverManager.getConnection(url, properties);
        sharedConnectionKey = key;
        return sharedConnection;
    }

    private static JsonNode executeQuery(JsonNode connection, String sql, String database, String schema) throws SQLException {
        long start = System.nanoTime();
        Connection conn = openConnection(connection);
        applyExecutionContext(connection, conn, database, schema);
        try (Statement statement = conn.createStatement()) {
            statement.setMaxRows(MAX_ROWS + 1);
            boolean hasResultSet = statement.execute(trimStatementSql(sql));
            ObjectNode result = MAPPER.createObjectNode();
            ArrayNode columns = MAPPER.createArrayNode();
            ArrayNode rows = MAPPER.createArrayNode();
            boolean truncated = false;

            if (hasResultSet) {
                try (ResultSet rs = statement.getResultSet()) {
                    ResultSetMetaData meta = rs.getMetaData();
                    int columnCount = meta.getColumnCount();
                    for (int i = 1; i <= columnCount; i++) {
                        String label = meta.getColumnLabel(i);
                        columns.add(label == null || label.isBlank() ? meta.getColumnName(i) : label);
                    }
                    while (rs.next()) {
                        if (rows.size() >= MAX_ROWS) {
                            truncated = true;
                            break;
                        }
                        ArrayNode row = MAPPER.createArrayNode();
                        for (int i = 1; i <= columnCount; i++) {
                            row.add(MAPPER.valueToTree(readValue(rs, meta, i)));
                        }
                        rows.add(row);
                    }
                }
            }

            result.set("columns", columns);
            result.set("rows", rows);
            result.put("affected_rows", hasResultSet ? 0 : Math.max(statement.getUpdateCount(), 0));
            result.put("execution_time_ms", (System.nanoTime() - start) / 1_000_000);
            result.put("truncated", truncated);
            return result;
        }
    }

    private static String trimStatementSql(String sql) {
        return sql == null ? "" : sql.trim().replaceFirst(";\\s*$", "");
    }

    private static void applyExecutionContext(JsonNode connection, Connection conn, String database, String schema) throws SQLException {
        if (driverQuirks(connection).skipExecutionContext()) {
            return;
        }
        if (database != null) {
            try {
                conn.setCatalog(database);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
            }
        }
        if (schema != null) {
            try {
                conn.setSchema(schema);
            } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
            }
        }
    }

    static JdbcDriverQuirks driverQuirks(JsonNode connection) {
        String url = optionalText(connection, "connection_string");
        for (JdbcDriverQuirkRule rule : DRIVER_QUIRK_RULES) {
            if (urlMatchesPrefix(url, rule.urlPrefix())) {
                return rule.quirks();
            }
        }
        return DEFAULT_QUIRKS;
    }

    private static boolean urlMatchesPrefix(String url, String prefix) {
        return url != null && url.regionMatches(true, 0, prefix, 0, prefix.length());
    }

    private static JsonNode listDatabases(JsonNode connection) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return result;
        }
        try (ResultSet rs = conn.getMetaData().getCatalogs()) {
            while (rs.next()) {
                String name = rs.getString("TABLE_CAT");
                addDatabase(result, name);
            }
        }
        addDatabase(result, optionalText(connection, "database"));
        try {
            addDatabase(result, conn.getCatalog());
        } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
        }
        return result;
    }

    private static void addDatabase(ArrayNode result, String name) {
        if (name == null || name.isBlank()) {
            return;
        }
        for (JsonNode item : result) {
            if (name.equals(item.path("name").asText())) {
                return;
            }
        }
        ObjectNode item = MAPPER.createObjectNode();
        item.put("name", name);
        result.add(item);
    }

    private static JsonNode listSchemas(JsonNode connection, String database) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleListSchemas(conn);
        }
            DatabaseMetaData meta = conn.getMetaData();
            try (ResultSet rs = meta.getSchemas(emptyToNull(database), null)) {
                appendSchemas(result, rs);
            } catch (SQLFeatureNotSupportedException ignored) {
                try (ResultSet rs = meta.getSchemas()) {
                    appendSchemas(result, rs);
                }
            }
            if (result.isEmpty() && database != null) {
                try (ResultSet rs = meta.getSchemas(null, null)) {
                    appendSchemas(result, rs);
                } catch (SQLFeatureNotSupportedException ignored) {
                }
            }
            if (result.isEmpty()) {
                try {
                    String schema = conn.getSchema();
                    if (schema != null) {
                        result.add(schema);
                    }
                } catch (SQLFeatureNotSupportedException | AbstractMethodError ignored) {
                }
            }
        return result;
    }

    private static JsonNode listTables(JsonNode connection, String database, String schema) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleListTables(conn, oracleEffectiveSchema(conn, schema));
        }
        String[] types = new String[] {"TABLE", "VIEW", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW"};
        DatabaseMetaData meta = conn.getMetaData();
        appendTables(result, meta, emptyToNull(database), emptyToNull(schema), types);
        if (result.isEmpty() && database != null) {
            appendTables(result, meta, null, emptyToNull(schema), types);
        }
        return result;
    }

    private static JsonNode listObjects(JsonNode connection, String database, String schema) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleListObjects(conn, oracleEffectiveSchema(conn, schema), schema);
        }
        DatabaseMetaData meta = conn.getMetaData();
        String catalog = emptyToNull(database);
        String schemaPattern = emptyToNull(schema);

        String[] tableTypes = new String[] {"TABLE", "VIEW", "MATERIALIZED VIEW", "SYSTEM TABLE", "SYSTEM VIEW"};
        appendTableObjects(result, meta, catalog, schemaPattern, schema, tableTypes);
        if (result.isEmpty() && database != null) {
            appendTableObjects(result, meta, null, schemaPattern, schema, tableTypes);
        }

        try (ResultSet rs = meta.getProcedures(catalog, schemaPattern, "%")) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("PROCEDURE_NAME"));
                item.put("object_type", "PROCEDURE");
                putNullable(item, "schema", schema);
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        } catch (SQLException ignored) {
        }

        Set<String> procedureNames = new HashSet<>();
        for (JsonNode node : result) {
            if ("PROCEDURE".equals(node.path("object_type").asText())) {
                procedureNames.add(node.path("name").asText());
            }
        }
        try (ResultSet rs = meta.getFunctions(catalog, schemaPattern, "%")) {
            while (rs.next()) {
                String name = rs.getString("FUNCTION_NAME");
                if (!procedureNames.contains(name)) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", name);
                    item.put("object_type", "FUNCTION");
                    putNullable(item, "schema", schema);
                    putNullable(item, "comment", rs.getString("REMARKS"));
                    result.add(item);
                }
            }
        } catch (SQLException ignored) {
        }

        return result;
    }

    private static JsonNode getColumns(JsonNode connection, String database, String schema, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Connection conn = openConnection(connection);
        if (driverQuirks(connection).useOracleMetadata()) {
            return oracleGetColumns(conn, oracleEffectiveSchema(conn, schema), table);
        }
            DatabaseMetaData meta = conn.getMetaData();
            Set<String> primaryKeys = primaryKeys(meta, database, schema, table);
            appendColumns(result, meta, emptyToNull(database), emptyToNull(schema), table, primaryKeys);
            if (result.isEmpty() && database != null) {
                primaryKeys = primaryKeys(meta, null, schema, table);
                appendColumns(result, meta, null, emptyToNull(schema), table, primaryKeys);
            }
        return result;
    }

    private static void appendSchemas(ArrayNode result, ResultSet rs) throws SQLException {
        while (rs.next()) {
            String schema = rs.getString("TABLE_SCHEM");
            if (schema != null && !schema.isBlank()) {
                result.add(schema);
            }
        }
    }

    private static void appendTables(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String[] types
    ) throws SQLException {
        try (ResultSet rs = meta.getTables(catalog, schema, "%", types)) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("TABLE_NAME"));
                item.put("table_type", rs.getString("TABLE_TYPE"));
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        }
    }

    private static void appendTableObjects(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schemaPattern,
        String schema,
        String[] tableTypes
    ) throws SQLException {
        try (ResultSet rs = meta.getTables(catalog, schemaPattern, "%", tableTypes)) {
            while (rs.next()) {
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", rs.getString("TABLE_NAME"));
                item.put("object_type", rs.getString("TABLE_TYPE"));
                putNullable(item, "schema", schema);
                putNullable(item, "comment", rs.getString("REMARKS"));
                result.add(item);
            }
        }
    }

    private static void appendColumns(
        ArrayNode result,
        DatabaseMetaData meta,
        String catalog,
        String schema,
        String table,
        Set<String> primaryKeys
    ) throws SQLException {
        try (ResultSet rs = meta.getColumns(catalog, schema, table, "%")) {
            while (rs.next()) {
                String name = rs.getString("COLUMN_NAME");
                ObjectNode item = MAPPER.createObjectNode();
                item.put("name", name);
                item.put("data_type", rs.getString("TYPE_NAME"));
                item.put("is_nullable", rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
                putNullable(item, "column_default", rs.getString("COLUMN_DEF"));
                item.put("is_primary_key", primaryKeys.contains(name));
                item.putNull("extra");
                putNullable(item, "comment", rs.getString("REMARKS"));
                putNullableInt(item, "numeric_precision", rs.getObject("COLUMN_SIZE"));
                putNullableInt(item, "numeric_scale", rs.getObject("DECIMAL_DIGITS"));
                putNullableInt(item, "character_maximum_length", rs.getObject("COLUMN_SIZE"));
                result.add(item);
            }
        }
    }

    private static void closeSharedConnection() {
        if (sharedConnection != null) {
            try {
                sharedConnection.close();
            } catch (SQLException ignored) {
            }
            sharedConnection = null;
            sharedConnectionKey = "";
        }
    }

    private static String driverKey(JsonNode connection) {
        return optionalText(connection, "jdbc_driver_class") + "|" + connection.path("jdbc_driver_paths").toString();
    }

    private static String connectionKey(JsonNode connection) {
        return optionalText(connection, "connection_string") + "|" + optionalText(connection, "username") + "|" + optionalText(connection, "password");
    }

    private static Set<String> primaryKeys(DatabaseMetaData meta, String database, String schema, String table) throws SQLException {
        Set<String> primaryKeys = new HashSet<>();
        try (ResultSet rs = meta.getPrimaryKeys(emptyToNull(database), emptyToNull(schema), table)) {
            while (rs.next()) {
                primaryKeys.add(rs.getString("COLUMN_NAME"));
            }
        }
        return primaryKeys;
    }

    // --- Oracle-specific metadata methods ---

    private static boolean isOracleUrl(String url) {
        return url != null && url.regionMatches(true, 0, "jdbc:oracle:", 0, 12);
    }

    private static String oracleEffectiveSchema(Connection conn, String schema) throws SQLException {
        if (schema != null && !schema.isBlank()) {
            return schema.toUpperCase();
        }
        return conn.getMetaData().getUserName();
    }

    private static JsonNode oracleListSchemas(Connection conn) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        try (Statement stmt = conn.createStatement();
             ResultSet rs = stmt.executeQuery("SELECT username FROM all_users ORDER BY username")) {
            while (rs.next()) {
                String name = rs.getString(1);
                if (name != null && !name.isBlank()) {
                    result.add(name);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleListTables(Connection conn, String owner) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String sql =
            "SELECT table_name AS name, 'TABLE' AS table_type, comments " +
            "FROM all_tab_comments WHERE owner = ? AND table_type = 'TABLE' " +
            "UNION ALL " +
            "SELECT table_name AS name, 'VIEW' AS table_type, comments " +
            "FROM all_tab_comments WHERE owner = ? AND table_type = 'VIEW' " +
            "ORDER BY name";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("table_type", rs.getString("table_type"));
                    putNullable(item, "comment", rs.getString("comments"));
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleListObjects(Connection conn, String owner, String schemaLabel) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        String tableSql =
            "SELECT table_name AS name, table_type AS object_type, comments " +
            "FROM all_tab_comments WHERE owner = ? ORDER BY name";
        try (PreparedStatement ps = conn.prepareStatement(tableSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    putNullable(item, "comment", rs.getString("comments"));
                    result.add(item);
                }
            }
        }
        String procSql =
            "SELECT object_name AS name, object_type " +
            "FROM all_procedures WHERE owner = ? AND object_type IN ('PROCEDURE', 'FUNCTION') " +
            "AND procedure_name IS NULL ORDER BY object_name";
        try (PreparedStatement ps = conn.prepareStatement(procSql)) {
            ps.setString(1, owner);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", rs.getString("name"));
                    item.put("object_type", rs.getString("object_type"));
                    putNullable(item, "schema", schemaLabel);
                    item.putNull("comment");
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static JsonNode oracleGetColumns(Connection conn, String owner, String table) throws SQLException {
        ArrayNode result = MAPPER.createArrayNode();
        Set<String> pks = oraclePrimaryKeys(conn, owner, table);
        String sql =
            "SELECT c.column_name, c.data_type, c.nullable, c.data_default, " +
            "c.data_precision, c.data_scale, c.char_length, cc.comments " +
            "FROM all_tab_columns c " +
            "LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name " +
            "WHERE c.owner = ? AND c.table_name = ? ORDER BY c.column_id";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, table);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    String name = rs.getString("column_name");
                    ObjectNode item = MAPPER.createObjectNode();
                    item.put("name", name);
                    item.put("data_type", rs.getString("data_type"));
                    item.put("is_nullable", !"N".equals(rs.getString("nullable")));
                    putNullable(item, "column_default", rs.getString("data_default"));
                    item.put("is_primary_key", pks.contains(name));
                    item.putNull("extra");
                    putNullable(item, "comment", rs.getString("comments"));
                    putNullableInt(item, "numeric_precision", rs.getObject("data_precision"));
                    putNullableInt(item, "numeric_scale", rs.getObject("data_scale"));
                    putNullableInt(item, "character_maximum_length", rs.getObject("char_length"));
                    result.add(item);
                }
            }
        }
        return result;
    }

    private static Set<String> oraclePrimaryKeys(Connection conn, String owner, String table) throws SQLException {
        Set<String> keys = new HashSet<>();
        String sql =
            "SELECT cols.column_name FROM all_constraints cons " +
            "JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name AND cons.owner = cols.owner " +
            "WHERE cons.constraint_type = 'P' AND cons.owner = ? AND cons.table_name = ?";
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, owner);
            ps.setString(2, table);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    keys.add(rs.getString("column_name"));
                }
            }
        }
        return keys;
    }

    private static Object readValue(ResultSet rs, ResultSetMetaData meta, int index) throws SQLException {
        Object value = rs.getObject(index);
        if (value == null) {
            return null;
        }
        if (value instanceof byte[] bytes) {
            return binaryToHex(bytes);
        }
        if (isBinaryColumn(meta, index)) {
            byte[] bytes = rs.getBytes(index);
            return bytes == null ? null : binaryToHex(bytes);
        }
        if (value instanceof Date || value instanceof Time || value instanceof Timestamp || value instanceof TemporalAccessor) {
            return value.toString();
        }
        if (value instanceof BigDecimal decimal) {
            return decimal;
        }
        if (value instanceof Number || value instanceof Boolean || value instanceof String) {
            return value;
        }
        return value.toString();
    }

    private static boolean isBinaryColumn(ResultSetMetaData meta, int index) throws SQLException {
        return switch (meta.getColumnType(index)) {
            case Types.BINARY,
                 Types.VARBINARY,
                 Types.LONGVARBINARY,
                 Types.BLOB -> true;
            default -> false;
        };
    }

    private static String binaryToHex(byte[] bytes) {
        StringBuilder out = new StringBuilder(2 + bytes.length * 2);
        out.append("0x");
        for (byte b : bytes) {
            out.append(Character.forDigit((b >> 4) & 0x0f, 16));
            out.append(Character.forDigit(b & 0x0f, 16));
        }
        return out.toString();
    }

    private static void putNullable(ObjectNode node, String field, String value) {
        if (value == null) {
            node.putNull(field);
        } else {
            node.put(field, value);
        }
    }

    private static void putNullableInt(ObjectNode node, String field, Object value) {
        if (value instanceof Number number) {
            node.put(field, number.intValue());
        } else {
            node.putNull(field);
        }
    }

    private static String requireText(JsonNode node, String field) {
        String value = optionalText(node, field);
        if (value == null) {
            throw new IllegalArgumentException(field + " is required.");
        }
        return value;
    }

    private static String optionalText(JsonNode node, String field) {
        JsonNode value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        String text = value.asText("").trim();
        return text.isEmpty() ? null : text;
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static Path expandHome(String path) {
        if (path.equals("~") || path.startsWith("~/")) {
            return Path.of(System.getProperty("user.home") + path.substring(1));
        }
        return Path.of(path);
    }

    private static final class DriverShim implements Driver {
        private final Driver driver;

        private DriverShim(Driver driver) {
            this.driver = driver;
        }

        @Override
        public Connection connect(String url, Properties info) throws SQLException {
            return driver.connect(url, info);
        }

        @Override
        public boolean acceptsURL(String url) throws SQLException {
            return driver.acceptsURL(url);
        }

        @Override
        public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
            return driver.getPropertyInfo(url, info);
        }

        @Override
        public int getMajorVersion() {
            return driver.getMajorVersion();
        }

        @Override
        public int getMinorVersion() {
            return driver.getMinorVersion();
        }

        @Override
        public boolean jdbcCompliant() {
            return driver.jdbcCompliant();
        }

        @Override
        public Logger getParentLogger() throws SQLFeatureNotSupportedException {
            return driver.getParentLogger();
        }
    }
}
