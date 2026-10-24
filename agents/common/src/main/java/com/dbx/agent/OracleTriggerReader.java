package com.dbx.agent;

import java.io.IOException;
import java.io.Reader;
import java.sql.Clob;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.SQLFeatureNotSupportedException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Exact Oracle-family trigger reads, shared by the JDBC-based native agents. */
public final class OracleTriggerReader {
    private static final int NAME_BATCH_SIZE = 500;
    private static final String OBJECT_MARKER = "DBX_TRIGGER_OBJECT_MARKER";
    private static final String ORACLE_SUMMARY_COLUMNS = "t.OWNER, t.TRIGGER_NAME, t.TRIGGERING_EVENT, t.TRIGGER_TYPE, "
        + "t.STATUS, t.TABLE_OWNER, t.TABLE_NAME, t.BASE_OBJECT_TYPE, t.WHEN_CLAUSE, t.REFERENCING_NAMES, t.DESCRIPTION";
    private final Connection connection;
    private final String engine;
    private final String version;

    public OracleTriggerReader(Connection connection, String engine) throws SQLException {
        this.connection = connection;
        this.engine = engine;
        String productVersion;
        try {
            productVersion = connection.getMetaData().getDatabaseProductVersion();
        } catch (SQLException error) {
            productVersion = null;
        }
        this.version = productVersion;
    }

    public List<TriggerInfo> listTriggers(String parentOwner, String parentName) throws SQLException {
        requireIdentity(parentOwner, parentName);
        return summaries("t.TABLE_OWNER = ? AND t.TABLE_NAME = ?", List.of(parentOwner, parentName), true);
    }

    /** Enrich only the already filtered/paged trigger rows, never one source query per row. */
    public void enrichObjects(List<ObjectInfo> objects, String owner) throws SQLException {
        List<ObjectInfo> triggers = objects.stream().filter(object -> "TRIGGER".equals(object.getObject_type())).toList();
        for (int start = 0; start < triggers.size(); start += NAME_BATCH_SIZE) {
            List<ObjectInfo> batch = triggers.subList(start, Math.min(start + NAME_BATCH_SIZE, triggers.size()));
            List<String> args = new ArrayList<>();
            args.add(owner);
            for (ObjectInfo object : batch) args.add(object.getName());
            String names = String.join(",", java.util.Collections.nCopies(batch.size(), "?"));
            Map<Identity, TriggerInfo> byIdentity = new LinkedHashMap<>();
            try {
                for (TriggerInfo trigger : summaries("t.OWNER = ? AND t.TRIGGER_NAME IN (" + names + ")", args, false)) {
                    OracleTriggerMetadata metadata = trigger.getOracle_metadata();
                    Identity identity = new Identity(metadata.owner(), metadata.name());
                    if (byIdentity.put(identity, trigger) != null) throw new SQLException("Trigger identity is not unique");
                }
                for (ObjectInfo object : batch) {
                    TriggerInfo trigger = byIdentity.get(new Identity(owner, object.getName()));
                    if (trigger == null) trigger = unavailable(object, owner, new OracleTriggerMetadata.ReadState("incomplete", "Trigger changed or is no longer visible; reload"));
                    attach(object, trigger);
                }
            } catch (SQLException error) {
                for (ObjectInfo object : batch) attach(object, unavailable(object, owner, readFailure(error)));
            }
        }
    }

    private static void attach(ObjectInfo object, TriggerInfo trigger) {
        object.setTrigger(trigger);
        object.setValid(trigger.getValid());
        OracleTriggerMetadata.Parent parent = trigger.getOracle_metadata().parent();
        object.setParent_schema(parent == null ? null : parent.owner());
        object.setParent_name(parent == null ? null : parent.name());
    }

    private TriggerInfo unavailable(ObjectInfo object, String owner, OracleTriggerMetadata.ReadState failure) {
        TriggerInfo trigger = new TriggerInfo(object.getName(), "", "");
        Map<String, OracleTriggerMetadata.ReadState> reads = new LinkedHashMap<>();
        reads.put("identity", new OracleTriggerMetadata.ReadState("incomplete", "Object version could not be verified"));
        for (String field : List.of("scope", "parent", "enabled", "validity")) reads.put(field, failure);
        trigger.setOracle_metadata(new OracleTriggerMetadata(1, "exact", engine, version, owner, object.getName(),
            "UNKNOWN", null, null, null, null, null, null, null, reads));
        return trigger;
    }

    public ObjectSource getObjectSource(String owner, String name) throws SQLException {
        requireIdentity(owner, name);
        List<TriggerInfo> beforeRows = summaries("t.OWNER = ? AND t.TRIGGER_NAME = ?", List.of(owner, name), true);
        if (beforeRows.size() > 1) throw new SQLException("Trigger identity is not unique");
        if (beforeRows.isEmpty()) {
            ObjectSource result = new ObjectSource(name, "TRIGGER", owner, "", false);
            TriggerInfo trigger = unavailable(new ObjectInfo(name, "TRIGGER", owner, null), owner, missing("Visible trigger"));
            trigger.getOracle_metadata().reads().put("identity", new OracleTriggerMetadata.ReadState("empty", "No visible trigger with this exact owner/name"));
            result.setTrigger(trigger);
            return result;
        }
        TriggerInfo before = beforeRows.get(0);
        if (!owner.equals(before.getOracle_metadata().owner()) || !name.equals(before.getName())) {
            throw new SQLException("Trigger identity does not match the exact request");
        }
        SourceText source = source(owner, name, before.getStatement());
        List<OracleTriggerMetadata.CompilationError> errors = null;
        OracleTriggerMetadata.ReadState errorState;
        try {
            errors = errors(owner, name);
            errorState = available();
        } catch (SQLException error) {
            errorState = readFailure(error);
        }
        List<TriggerInfo> afterRows = summaries("t.OWNER = ? AND t.TRIGGER_NAME = ?", List.of(owner, name), true);
        boolean stable = afterRows.size() == 1 && before.equals(afterRows.get(0));
        TriggerInfo current = afterRows.size() == 1 ? afterRows.get(0) : before;
        OracleTriggerMetadata metadata = current.getOracle_metadata();
        Map<String, OracleTriggerMetadata.ReadState> reads = new LinkedHashMap<>(metadata.reads());
        reads.put("definition", stable ? source.state() : new OracleTriggerMetadata.ReadState("incomplete", "Trigger changed while loading; reload"));
        reads.put("errors", errorState);
        if (!stable) reads.put("identity", new OracleTriggerMetadata.ReadState("incomplete", "Trigger changed while loading; reload"));
        current.setOracle_metadata(new OracleTriggerMetadata(1, "exact", engine, version, metadata.owner(), metadata.name(),
            metadata.scope(), metadata.scopeType(), metadata.scopeOwner(), metadata.parent(), metadata.objectId(), metadata.lastDdlTime(),
            new OracleTriggerMetadata.Definition(source.origin(), source.format(), stable && source.complete()), errors, reads));
        ObjectSource result = new ObjectSource(name, "TRIGGER", owner, source.text());
        result.setTrigger(current);
        return result;
    }

    private List<TriggerInfo> summaries(String predicate, List<String> args, boolean includeBody) throws SQLException {
        // DM releases differ in optional trigger/object columns. SELECT * keeps a
        // missing column distinguishable from an error reading a present column.
        String projection = "dm".equals(engine) || includeBody ? "t.*" : ORACLE_SUMMARY_COLUMNS;
        String sql = "SELECT " + projection + ", o.OBJECT_NAME AS " + OBJECT_MARKER + ", o.* FROM ALL_TRIGGERS t "
            + "LEFT JOIN ALL_OBJECTS o ON o.OWNER = t.OWNER AND o.OBJECT_NAME = t.TRIGGER_NAME AND o.OBJECT_TYPE = 'TRIGGER' "
            + "WHERE " + predicate + " ORDER BY t.TRIGGER_NAME, t.OWNER";
        List<TriggerInfo> result = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement(sql)) {
            for (int i = 0; i < args.size(); i++) statement.setString(i + 1, args.get(i));
            try (ResultSet rows = statement.executeQuery()) {
                Columns columns = new Columns(rows.getMetaData());
                while (rows.next()) result.add(summary(rows, columns, includeBody));
            }
        }
        return result;
    }

    private TriggerInfo summary(ResultSet row, Columns columns, boolean includeBody) throws SQLException {
        String owner = columns.trigger(row, "OWNER");
        String name = columns.trigger(row, "TRIGGER_NAME");
        requireIdentity(owner, name);
        String event = columns.trigger(row, "TRIGGERING_EVENT");
        String timing = columns.trigger(row, "TRIGGER_TYPE");
        TriggerInfo trigger = new TriggerInfo(name, event == null ? "" : event, timing == null ? "" : timing);
        trigger.setEnabled(enabled(columns.trigger(row, "STATUS")));
        trigger.setValid(validity(columns.object(row, "STATUS")));
        trigger.setCondition(columns.trigger(row, "WHEN_CLAUSE"));
        if (includeBody) trigger.setStatement(columns.trigger(row, "TRIGGER_BODY"));
        String scopeType = columns.trigger(row, "BASE_OBJECT_TYPE");
        String scope = scopeType == null ? "UNKNOWN" : switch (scopeType.toUpperCase(Locale.ROOT)) {
            case "TABLE", "VIEW", "SCHEMA", "DATABASE", "TIMER" -> scopeType.toUpperCase(Locale.ROOT);
            default -> "OTHER";
        };
        if ("dm".equals(engine) && "DATABASE".equals(scope) && "TIMER".equalsIgnoreCase(event)) scope = "TIMER";
        String parentOwner = columns.trigger(row, "TABLE_OWNER");
        String parentName = columns.trigger(row, "TABLE_NAME");
        OracleTriggerMetadata.Parent parent = ("TABLE".equals(scope) || "VIEW".equals(scope)) && parentOwner != null && parentName != null
            ? new OracleTriggerMetadata.Parent(parentOwner, parentName, scope, null) : null;
        String objectId = columns.object(row, "OBJECT_ID");
        Map<String, OracleTriggerMetadata.ReadState> reads = new LinkedHashMap<>();
        reads.put("identity", objectId == null ? missing("Object ID") : available());
        reads.put("scope", "UNKNOWN".equals(scope) ? missing("Trigger scope") : available());
        reads.put("parent", "UNKNOWN".equals(scope) || "OTHER".equals(scope)
            || ("TABLE".equals(scope) || "VIEW".equals(scope)) && parent == null ? missing("Owning object") : available());
        if ("SCHEMA".equals(scope) && parentOwner == null) reads.put("scope", missing("Scope owner"));
        reads.put("enabled", trigger.getEnabled() == null ? missing("Enabled state") : available());
        reads.put("validity", trigger.getValid() == null ? missing("Object validity") : available());
        trigger.setOracle_metadata(new OracleTriggerMetadata(1, "exact", engine, version, owner, name, scope, scopeType,
            "SCHEMA".equals(scope) ? parentOwner : null, parent, objectId, columns.object(row, "LAST_DDL_TIME"), null, null, reads));
        return trigger;
    }

    private SourceText source(String owner, String name, String body) throws SQLException {
        SQLException firstError = null;
        boolean metadataFirst = "dm".equals(engine);
        for (boolean metadata : new boolean[]{metadataFirst, !metadataFirst}) {
            try {
                String text = metadata ? metadataSource(owner, name) : dictionarySource(owner, name);
                if (text != null && !text.isBlank()) return new SourceText(text, metadata ? "DBMS_METADATA" : "ALL_SOURCE",
                    metadata ? "ddl" : "declaration", true, available());
            } catch (SQLException error) {
                if (firstError == null) firstError = error;
            }
        }
        return new SourceText(body == null ? "" : body, "catalog-body", "body", false,
            firstError == null ? missing("Complete trigger definition") : readFailure(firstError));
    }

    private String dictionarySource(String owner, String name) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT LINE, TEXT FROM ALL_SOURCE WHERE OWNER = ? AND NAME = ? AND TYPE = 'TRIGGER' ORDER BY LINE")) {
            statement.setString(1, owner);
            statement.setString(2, name);
            StringBuilder text = new StringBuilder();
            long expectedLine = 1;
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    if (rows.getLong(1) != expectedLine++ || rows.wasNull()) throw new SQLException("Trigger source dictionary lines are incomplete");
                    String line = text(rows, 2);
                    if (line == null) throw new SQLException("Trigger source contains an unreadable line");
                    text.append(line);
                }
            }
            return text.toString();
        }
    }

    private String metadataSource(String owner, String name) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT DBMS_METADATA.GET_DDL(?, ?, ?) FROM DUAL")) {
            statement.setString(1, "TRIGGER");
            statement.setString(2, name);
            statement.setString(3, owner);
            try (ResultSet rows = statement.executeQuery()) {
                return rows.next() ? text(rows, 1) : null;
            }
        }
    }

    private List<OracleTriggerMetadata.CompilationError> errors(String owner, String name) throws SQLException {
        List<OracleTriggerMetadata.CompilationError> result = new ArrayList<>();
        try (PreparedStatement statement = connection.prepareStatement("SELECT SEQUENCE, LINE, POSITION, TEXT, ATTRIBUTE FROM ALL_ERRORS WHERE OWNER = ? AND NAME = ? AND TYPE = 'TRIGGER' ORDER BY SEQUENCE")) {
            statement.setString(1, owner);
            statement.setString(2, name);
            try (ResultSet rows = statement.executeQuery()) {
                while (rows.next()) {
                    String text = text(rows, 4);
                    if (text == null) throw new SQLException("Trigger compilation error text is unreadable");
                    result.add(new OracleTriggerMetadata.CompilationError(rows.getLong(1), rows.getLong(2), rows.getLong(3), text, rows.getString(5)));
                }
            }
        }
        return result;
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
        // Once a stream has started, a failed read must not fall back to a
        // potentially truncated getString() and claim a complete definition.
        try (Reader reader = stream) {
            StringBuilder text = new StringBuilder();
            char[] buffer = new char[8192];
            for (int count; (count = reader.read(buffer)) != -1;) text.append(buffer, 0, count);
            return text.toString();
        } catch (IOException error) {
            throw new SQLException("Trigger text could not be read completely", error);
        }
    }

    private static void requireIdentity(String owner, String name) throws SQLException {
        if (owner == null || owner.isEmpty() || name == null || name.isEmpty()) throw new SQLException("Exact trigger metadata requires owner and name");
    }

    private static Boolean enabled(String status) {
        if (status == null) return null;
        return switch (status.trim().toUpperCase(Locale.ROOT)) {
            case "ENABLED", "ENABLE", "Y" -> true;
            case "DISABLED", "DISABLE", "N" -> false;
            default -> null;
        };
    }

    private static Boolean validity(String status) {
        if (status == null) return null;
        return switch (status.trim().toUpperCase(Locale.ROOT)) { case "VALID" -> true; case "INVALID" -> false; default -> null; };
    }

    private static OracleTriggerMetadata.ReadState available() { return new OracleTriggerMetadata.ReadState("available", null); }
    private static OracleTriggerMetadata.ReadState missing(String field) { return new OracleTriggerMetadata.ReadState("unavailable", field + " is not exposed by this dictionary"); }
    private static OracleTriggerMetadata.ReadState readFailure(SQLException error) {
        int code = error.getErrorCode();
        String state = error.getSQLState();
        String category = code == 1031 || "42501".equals(state) ? "denied"
            : code == 942 || code == 904 || "42S02".equals(state) || "42S22".equals(state) ? "unavailable" : "error";
        return new OracleTriggerMetadata.ReadState(category, "Metadata read failed (SQLState " + state + ", code " + code + ")");
    }

    private record Identity(String owner, String name) {}
    private record SourceText(String text, String origin, String format, boolean complete, OracleTriggerMetadata.ReadState state) {}

    private static final class Columns {
        private final Map<String, Integer> trigger = new LinkedHashMap<>();
        private final Map<String, Integer> object = new LinkedHashMap<>();

        Columns(ResultSetMetaData metadata) throws SQLException {
            boolean objectColumns = false;
            for (int i = 1; i <= metadata.getColumnCount(); i++) {
                String label = metadata.getColumnLabel(i).toUpperCase(Locale.ROOT);
                if (OBJECT_MARKER.equals(label)) { objectColumns = true; continue; }
                (objectColumns ? object : trigger).putIfAbsent(label, i);
            }
        }

        String trigger(ResultSet row, String name) throws SQLException { return value(row, trigger, name); }
        String object(ResultSet row, String name) throws SQLException { return value(row, object, name); }
        private static String value(ResultSet row, Map<String, Integer> columns, String name) throws SQLException {
            Integer index = columns.get(name);
            return index == null ? null : "TRIGGER_BODY".equals(name) ? text(row, index) : row.getString(index);
        }
    }
}
