package app.dbx.jdbc;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.Reader;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Trigger metadata for this independently packaged JDBC runtime. */
final class OracleTriggerMetadataReader {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String OBJECT_MARKER = "DBX_TRIGGER_OBJECT_MARKER";
    private static final List<String> OBJECT_TYPES = List.of("TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY", "SEQUENCE", "SYNONYM", "TRIGGER", "TYPE", "TYPE_BODY");
    record Profile(String engine, String version) {}
    private final Connection connection;
    private final Profile profile;

    OracleTriggerMetadataReader(Connection connection, Profile profile) {
        this.connection = connection;
        this.profile = profile;
    }

    /** Confirm the connected product, not an editable connection label. */
    static Profile profile(Connection connection) throws SQLException {
        var metadata = connection.getMetaData();
        String product = metadata.getDatabaseProductName();
        String version = metadata.getDatabaseProductVersion();
        if ("OceanBase".equalsIgnoreCase(product)) {
            // This Oracle-only read distinguishes OceanBase's two tenant modes.
            try (var statement = connection.prepareStatement("SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM DUAL");
                 var rows = statement.executeQuery()) {
                if (rows.next() && rows.getString(1) != null) return new Profile("oceanbase-oracle", version);
            }
            return null;
        }
        if ("Oracle".equalsIgnoreCase(product) || "Oracle Database".equalsIgnoreCase(product)) return new Profile("oracle", version);
        String url = metadata.getURL();
        if (url != null && url.regionMatches(true, 0, "jdbc:dm:", 0, 8)
            && product != null && (product.toUpperCase(Locale.ROOT).startsWith("DM") || product.equalsIgnoreCase("Dameng"))
            && metadata.getDatabaseMajorVersion() == 8) return new Profile("dm", version);
        return null;
    }

    ArrayNode listObjects(String owner, String filter, int limit, int offset, List<String> requestedTypes) throws SQLException {
        requireIdentity(owner);
        LinkedHashSet<String> types = new LinkedHashSet<>();
        for (String type : requestedTypes == null || requestedTypes.isEmpty() ? OBJECT_TYPES : requestedTypes) {
            String normalized = type.trim().toUpperCase(Locale.ROOT).replace(' ', '_');
            if (OBJECT_TYPES.contains(normalized)) types.add(normalized.replace('_', ' '));
        }
        ArrayNode result = JSON.createArrayNode();
        if (types.isEmpty()) return result;
        List<Object> args = new ArrayList<>();
        args.add(owner);
        args.addAll(types);
        String sql = "SELECT o.OBJECT_NAME, REPLACE(o.OBJECT_TYPE,' ','_') AS OBJECT_TYPE, c.COMMENTS FROM ALL_OBJECTS o "
            + "LEFT JOIN ALL_TAB_COMMENTS c ON c.OWNER=o.OWNER AND c.TABLE_NAME=o.OBJECT_NAME AND o.OBJECT_TYPE IN ('TABLE','VIEW') "
            + "WHERE o.OWNER=? AND o.OBJECT_TYPE IN (" + String.join(",", java.util.Collections.nCopies(types.size(), "?")) + ")";
        if (filter != null && !filter.isBlank()) {
            StringBuilder pattern = new StringBuilder("%");
            for (char ch : filter.trim().toUpperCase(Locale.ROOT).toCharArray()) {
                if (ch == '~' || ch == '%' || ch == '_') pattern.append('~');
                pattern.append(ch).append('%');
            }
            sql += " AND (UPPER(o.OBJECT_NAME) LIKE ? ESCAPE '~' OR UPPER(c.COMMENTS) LIKE ? ESCAPE '~')";
            args.add(pattern.toString());
            args.add(pattern.toString());
        }
        sql += " ORDER BY CASE o.OBJECT_TYPE WHEN 'TABLE' THEN 0 WHEN 'VIEW' THEN 1 WHEN 'MATERIALIZED VIEW' THEN 2 WHEN 'PROCEDURE' THEN 3 WHEN 'FUNCTION' THEN 4 WHEN 'SEQUENCE' THEN 5 WHEN 'SYNONYM' THEN 6 WHEN 'PACKAGE' THEN 7 ELSE 8 END, o.OBJECT_NAME, o.OWNER, o.OBJECT_ID";
        if (limit > 0 || offset > 0) {
            sql = "SELECT OBJECT_NAME, OBJECT_TYPE, COMMENTS FROM (SELECT dbx_page.*, ROWNUM DBX_RN FROM (" + sql + ") dbx_page"
                + (limit > 0 ? " WHERE ROWNUM <= ?" : "") + ") WHERE DBX_RN > ?";
            if (limit > 0) args.add((long) limit + offset);
            args.add(offset);
        }
        try (var statement = connection.prepareStatement(sql)) {
            for (int i = 0; i < args.size(); i++) statement.setObject(i + 1, args.get(i));
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    ObjectNode object = result.addObject();
                    object.put("name", rows.getString(1));
                    object.put("object_type", rows.getString(2));
                    object.put("schema", owner);
                    object.put("comment", rows.getString(3));
                }
            }
        }
        enrich(result, owner);
        return result;
    }

    private void enrich(ArrayNode objects, String owner) throws SQLException {
        List<ObjectNode> triggers = new ArrayList<>();
        objects.forEach(object -> {
            if ("TRIGGER".equals(object.path("object_type").asText())) triggers.add((ObjectNode) object);
        });
        for (int start = 0; start < triggers.size(); start += 500) {
            List<ObjectNode> batch = triggers.subList(start, Math.min(start + 500, triggers.size()));
            List<String> args = new ArrayList<>();
            args.add(owner);
            batch.forEach(object -> args.add(object.path("name").asText()));
            try {
                ArrayNode summaries = summaries("t.OWNER=? AND t.TRIGGER_NAME IN (" + String.join(",", java.util.Collections.nCopies(batch.size(), "?")) + ")", args, false);
                Map<String, JsonNode> byName = new LinkedHashMap<>();
                for (JsonNode trigger : summaries) {
                    if (owner.equals(trigger.path("oracle_metadata").path("owner").asText())) {
                        if (byName.put(trigger.path("name").asText(), trigger) != null) throw new SQLException("Trigger identity is not unique");
                    }
                }
                for (ObjectNode object : batch) {
                    JsonNode trigger = byName.get(object.path("name").asText());
                    if (trigger == null) trigger = unknown(owner, object.path("name").asText(), state("incomplete", "Trigger changed or is no longer visible; reload"));
                    object.set("trigger", trigger);
                    object.set("valid", trigger.path("valid"));
                    JsonNode parent = trigger.path("oracle_metadata").path("parent");
                    if (parent.isObject()) {
                        object.set("parent_schema", parent.path("owner"));
                        object.set("parent_name", parent.path("name"));
                    }
                }
            } catch (SQLException error) {
                for (ObjectNode object : batch) object.set("trigger", unknown(owner, object.path("name").asText(), failure(error)));
            }
        }
    }

    ArrayNode listTriggers(String owner, String parent) throws SQLException {
        requireIdentity(owner);
        requireIdentity(parent);
        return summaries("t.TABLE_OWNER=? AND t.TABLE_NAME=?", List.of(owner, parent), true);
    }

    private ArrayNode summaries(String predicate, List<String> args, boolean body) throws SQLException {
        String columns = body || profile.engine().equals("dm") ? "t.*"
            : "t.OWNER,t.TRIGGER_NAME,t.TRIGGERING_EVENT,t.TRIGGER_TYPE,t.STATUS,t.TABLE_OWNER,t.TABLE_NAME,t.BASE_OBJECT_TYPE,t.WHEN_CLAUSE";
        String sql = "SELECT " + columns + ",o.OBJECT_NAME AS " + OBJECT_MARKER + ",o.* FROM ALL_TRIGGERS t LEFT JOIN ALL_OBJECTS o "
            + "ON o.OWNER=t.OWNER AND o.OBJECT_NAME=t.TRIGGER_NAME AND o.OBJECT_TYPE='TRIGGER' WHERE " + predicate + " ORDER BY t.TRIGGER_NAME,t.OWNER";
        ArrayNode result = JSON.createArrayNode();
        try (var statement = connection.prepareStatement(sql)) {
            for (int i = 0; i < args.size(); i++) statement.setString(i + 1, args.get(i));
            try (var rows = statement.executeQuery()) {
                Columns mapping = new Columns(rows.getMetaData());
                while (rows.next()) {
                    String owner = mapping.trigger(rows, "OWNER");
                    String name = mapping.trigger(rows, "TRIGGER_NAME");
                    requireIdentity(owner);
                    requireIdentity(name);
                    ObjectNode trigger = result.addObject();
                    trigger.put("name", name);
                    String event = mapping.trigger(rows, "TRIGGERING_EVENT");
                    String timing = mapping.trigger(rows, "TRIGGER_TYPE");
                    trigger.put("event", event == null ? "" : event);
                    trigger.put("timing", timing == null ? "" : timing);
                    trigger.put("condition", mapping.trigger(rows, "WHEN_CLAUSE"));
                    Boolean enabled = enabled(mapping.trigger(rows, "STATUS"));
                    Boolean valid = valid(mapping.object(rows, "STATUS"));
                    if (enabled != null) trigger.put("enabled", enabled);
                    if (valid != null) trigger.put("valid", valid);
                    if (body) trigger.put("statement", mapping.trigger(rows, "TRIGGER_BODY"));
                    ObjectNode metadata = metadata(owner, name);
                    trigger.set("oracle_metadata", metadata);
                    String scopeType = mapping.trigger(rows, "BASE_OBJECT_TYPE");
                    String scope = scopeType == null ? "UNKNOWN" : switch (scopeType.toUpperCase(Locale.ROOT)) {
                        case "TABLE", "VIEW", "SCHEMA", "DATABASE", "TIMER" -> scopeType.toUpperCase(Locale.ROOT);
                        default -> "OTHER";
                    };
                    if (profile.engine().equals("dm") && scope.equals("DATABASE") && "TIMER".equalsIgnoreCase(event)) scope = "TIMER";
                    metadata.put("scope", scope);
                    metadata.put("scopeType", scopeType);
                    String parentOwner = mapping.trigger(rows, "TABLE_OWNER");
                    String parentName = mapping.trigger(rows, "TABLE_NAME");
                    if (List.of("TABLE", "VIEW").contains(scope) && parentOwner != null && parentName != null) {
                        ObjectNode parent = metadata.putObject("parent");
                        parent.put("owner", parentOwner);
                        parent.put("name", parentName);
                        parent.put("objectType", scope);
                    }
                    if (scope.equals("SCHEMA")) metadata.put("scopeOwner", parentOwner);
                    String id = mapping.object(rows, "OBJECT_ID");
                    metadata.put("objectId", id);
                    metadata.put("lastDdlTime", mapping.object(rows, "LAST_DDL_TIME"));
                    ObjectNode reads = metadata.withObject("reads");
                    reads.set("identity", id == null ? missing("Object ID") : available());
                    reads.set("scope", scope.equals("UNKNOWN") || scope.equals("SCHEMA") && parentOwner == null ? missing("Trigger scope") : available());
                    reads.set("parent", List.of("UNKNOWN", "OTHER").contains(scope) || List.of("TABLE", "VIEW").contains(scope) && !metadata.has("parent") ? missing("Owning object") : available());
                    reads.set("enabled", enabled == null ? missing("Enabled state") : available());
                    reads.set("validity", valid == null ? missing("Object validity") : available());
                }
            }
        }
        return result;
    }

    ObjectNode source(String owner, String name) throws SQLException {
        requireIdentity(owner);
        requireIdentity(name);
        List<String> args = List.of(owner, name);
        ArrayNode before = summaries("t.OWNER=? AND t.TRIGGER_NAME=?", args, true);
        ObjectNode result = JSON.createObjectNode();
        result.put("name", name);
        result.put("schema", owner);
        result.put("object_type", "TRIGGER");
        if (before.isEmpty()) {
            result.put("source", "");
            result.put("editable", false);
            ObjectNode trigger = unknown(owner, name, missing("Visible trigger"));
            trigger.withObject("oracle_metadata").withObject("reads").set("identity", state("empty", "No visible trigger with this exact owner/name"));
            result.set("trigger", trigger);
            return result;
        }
        if (before.size() != 1 || !owner.equals(before.get(0).path("oracle_metadata").path("owner").asText())
            || !name.equals(before.get(0).path("name").asText())) {
            throw new SQLException("Trigger identity does not match the exact request");
        }
        String text = "", origin = "catalog-body", format = "body";
        ObjectNode sourceState = missing("Complete trigger definition");
        boolean metadataFirst = profile.engine().equals("dm");
        for (boolean useMetadata : new boolean[]{metadataFirst, !metadataFirst}) {
            try {
                String source = definition(owner, name, useMetadata);
                if (!source.isBlank()) {
                    text = source;
                    origin = useMetadata ? "DBMS_METADATA" : "ALL_SOURCE";
                    format = useMetadata ? "ddl" : "declaration";
                    sourceState = available();
                    break;
                }
            } catch (SQLException error) {
                sourceState = failure(error);
            }
        }
        if (text.isEmpty()) text = before.get(0).path("statement").asText("");
        ArrayNode errors = null;
        ObjectNode errorState;
        try {
            errors = errors(owner, name);
            errorState = available();
        } catch (SQLException error) {
            errorState = failure(error);
        }
        ArrayNode after = summaries("t.OWNER=? AND t.TRIGGER_NAME=?", args, true);
        boolean stable = before.equals(after);
        ObjectNode trigger = (ObjectNode) (after.size() == 1 ? after.get(0) : before.get(0));
        ObjectNode metadata = (ObjectNode) trigger.path("oracle_metadata");
        ObjectNode reads = metadata.withObject("reads");
        ObjectNode definition = metadata.putObject("definition");
        definition.put("origin", origin);
        definition.put("format", format);
        definition.put("complete", stable && sourceState.path("state").asText().equals("available") && !format.equals("body"));
        reads.set("definition", sourceState);
        reads.set("errors", errorState);
        metadata.set("errors", errors);
        if (!stable) {
            ObjectNode changed = state("incomplete", "Trigger changed while loading; reload");
            reads.set("identity", changed);
            reads.set("definition", changed);
        }
        result.put("source", text);
        result.set("trigger", trigger);
        return result;
    }

    private String definition(String owner, String name, boolean metadata) throws SQLException {
        String sql = metadata ? "SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL" : "SELECT LINE,TEXT FROM ALL_SOURCE WHERE OWNER=? AND NAME=? AND TYPE='TRIGGER' ORDER BY LINE";
        try (var statement = connection.prepareStatement(sql)) {
            if (metadata) {
                statement.setString(1, "TRIGGER");
                statement.setString(2, name);
                statement.setString(3, owner);
            } else {
                statement.setString(1, owner);
                statement.setString(2, name);
            }
            StringBuilder source = new StringBuilder();
            long expectedLine = 1;
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (!metadata && (rows.getLong(1) != expectedLine++ || rows.wasNull())) throw new SQLException("Trigger source dictionary lines are incomplete");
                    String text = text(rows, metadata ? 1 : 2);
                    if (text == null) throw new SQLException("Trigger source contains an unreadable line");
                    source.append(text);
                }
            }
            return source.toString();
        }
    }

    private ArrayNode errors(String owner, String name) throws SQLException {
        ArrayNode errors = JSON.createArrayNode();
        try (var statement = connection.prepareStatement("SELECT SEQUENCE,LINE,POSITION,TEXT,ATTRIBUTE FROM ALL_ERRORS WHERE OWNER=? AND NAME=? AND TYPE='TRIGGER' ORDER BY SEQUENCE")) {
            statement.setString(1, owner);
            statement.setString(2, name);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    String text = text(rows, 4);
                    if (text == null) throw new SQLException("Trigger compilation error text is unreadable");
                    ObjectNode error = errors.addObject();
                    error.put("sequence", rows.getLong(1));
                    error.put("line", rows.getLong(2));
                    error.put("position", rows.getLong(3));
                    error.put("text", text);
                    error.put("severity", rows.getString(5));
                }
            }
        }
        return errors;
    }

    private ObjectNode metadata(String owner, String name) {
        ObjectNode metadata = JSON.createObjectNode();
        metadata.put("contractVersion", 1);
        metadata.put("identityMode", "exact");
        metadata.put("engine", profile.engine());
        metadata.put("engineVersion", profile.version());
        metadata.put("owner", owner);
        metadata.put("name", name);
        metadata.putObject("reads");
        return metadata;
    }

    private ObjectNode unknown(String owner, String name, ObjectNode failure) {
        ObjectNode trigger = JSON.createObjectNode();
        trigger.put("name", name);
        trigger.put("event", "");
        trigger.put("timing", "");
        ObjectNode metadata = metadata(owner, name);
        metadata.put("scope", "UNKNOWN");
        trigger.set("oracle_metadata", metadata);
        for (String field : List.of("identity", "scope", "parent", "enabled", "validity")) metadata.withObject("reads").set(field, failure);
        return trigger;
    }

    private static ObjectNode state(String state, String message) {
        ObjectNode value = JSON.createObjectNode();
        value.put("state", state);
        if (message != null) value.put("message", message);
        return value;
    }
    private static ObjectNode available() { return state("available", null); }
    private static ObjectNode missing(String field) { return state("unavailable", field + " is not exposed by this dictionary"); }
    private static ObjectNode failure(SQLException error) {
        String code = error.getSQLState();
        int vendor = error.getErrorCode();
        String state = vendor == 1031 || "42501".equals(code) ? "denied"
            : vendor == 942 || vendor == 904 || "42S02".equals(code) || "42S22".equals(code) ? "unavailable" : "error";
        return state(state, "Metadata read failed (SQLState " + code + ", code " + vendor + ")");
    }

    private static void requireIdentity(String value) throws SQLException {
        if (value == null || value.isEmpty()) throw new SQLException("Exact trigger metadata requires owner and name");
    }

    private static Boolean enabled(String value) {
        if (value == null) return null;
        return switch (value.trim().toUpperCase(Locale.ROOT)) {
            case "ENABLED", "ENABLE", "Y" -> true;
            case "DISABLED", "DISABLE", "N" -> false;
            default -> null;
        };
    }

    private static Boolean valid(String value) {
        if (value == null) return null;
        return switch (value.trim().toUpperCase(Locale.ROOT)) {
            case "VALID" -> true;
            case "INVALID" -> false;
            default -> null;
        };
    }

    private static String text(ResultSet rows, int column) throws SQLException {
        Reader stream;
        try {
            stream = rows.getCharacterStream(column);
        } catch (SQLFeatureNotSupportedException | AbstractMethodError unsupported) {
            stream = null;
        }
        if (stream == null) {
            Object value = rows.getObject(column);
            if (!(value instanceof Clob clob)) return rows.getString(column);
            stream = clob.getCharacterStream();
        }
        try (Reader reader = stream) {
            StringBuilder text = new StringBuilder();
            char[] buffer = new char[8192];
            for (int count; (count = reader.read(buffer)) != -1;) text.append(buffer, 0, count);
            return text.toString();
        } catch (IOException error) {
            throw new SQLException("Trigger text could not be read completely", error);
        }
    }

    private static final class Columns {
        private final Map<String, Integer> trigger = new LinkedHashMap<>();
        private final Map<String, Integer> object = new LinkedHashMap<>();

        Columns(ResultSetMetaData metadata) throws SQLException {
            boolean objects = false;
            for (int i = 1; i <= metadata.getColumnCount(); i++) {
                String label = metadata.getColumnLabel(i).toUpperCase(Locale.ROOT);
                if (label.equals(OBJECT_MARKER)) {
                    objects = true;
                    continue;
                }
                (objects ? object : trigger).putIfAbsent(label, i);
            }
        }

        String trigger(ResultSet rows, String field) throws SQLException {
            Integer index = trigger.get(field);
            return index == null ? null : field.equals("TRIGGER_BODY") ? text(rows, index) : rows.getString(index);
        }

        String object(ResultSet rows, String field) throws SQLException {
            Integer index = object.get(field);
            return index == null ? null : rows.getString(index);
        }
    }
}
