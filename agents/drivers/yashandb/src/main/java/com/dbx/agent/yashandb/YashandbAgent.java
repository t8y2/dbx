package com.dbx.agent.yashandb;

import com.dbx.agent.ConfiguredJdbcAgent;
import com.dbx.agent.EwkbWktDecoder;
import com.dbx.agent.JdbcAgentProfile;
import com.dbx.agent.JdbcExecutor;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.ObjectSource;
import com.dbx.agent.SpatialValue;
import java.sql.Blob;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Struct;
import java.sql.Types;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Locale;
import java.util.Set;

public final class YashandbAgent extends ConfiguredJdbcAgent {
    private static final int MAX_STRUCT_DEPTH = 8;
    /**
     * YashanDB stores geometry payloads as a UDT with {@code HEAD(RAW 40)} and
     * {@code GEOM(BLOB)} attributes. The GEOM blob is EWKB (SRID included), so
     * it can be decoded into WKT just like PostGIS. Bound the blob read so a
     * pathological 4 GB geometry cannot exhaust the agent heap; oversized
     * values keep the pre-existing struct-text fallback.
     */
    private static final long MAX_GEOMETRY_BYTES = 64L * 1024 * 1024;
    static final String OBJECT_SOURCE_SQL = """
        SELECT TEXT
        FROM ALL_SOURCE
        WHERE OWNER = ?
          AND NAME = ?
          AND TYPE = ?
        ORDER BY LINE
        """.stripIndent().trim();

    public static final JdbcAgentProfile YASHANDB_PROFILE = new JdbcAgentProfile(
        "com.yashandb.jdbc.Driver",
        "jdbc:yasdb://{host}:{port}/{database}",
        1688,
        true
    );

    public YashandbAgent() {
        super(YASHANDB_PROFILE);
    }

    @Override
    protected JdbcExecutor.ResultValueReader resultValueReader() {
        return (JdbcExecutor.ColumnAwareResultValueReader) this::readYashandbValue;
    }

    private Object readYashandbValue(ResultSet resultSet, int index, int sqlType, String columnTypeName) throws SQLException {
        if (isStGeometryType(columnTypeName)) {
            return readGeometryValue(resultSet, index);
        }
        if (!isStructuredValue(sqlType, columnTypeName)) {
            return super.resultValue(resultSet, index, sqlType);
        }
        // YashanDB JDBC rejects getString for UDT accessors; materialize the structured object instead.
        Object value = resultSet.getObject(index);
        if (value == null || resultSet.wasNull()) {
            return null;
        }
        if (value instanceof Struct) {
            return normalizeStructuredValue((Struct) value);
        }
        return JdbcExecutor.normalizeResultValue(value);
    }

    /**
     * Decode a {@code MDSYS.ST_GEOMETRY} cell into WKT plus its SRID, matching
     * the PostGIS path so the desktop grid can offer the map preview. The
     * GEOM attribute is EWKB (verified against YashanDB 23.4); if the payload
     * is missing or malformed we keep the previous struct text so the value
     * stays visible instead of failing the whole query.
     */
    private static Object readGeometryValue(ResultSet resultSet, int index) throws SQLException {
        Object value = resultSet.getObject(index);
        if (value == null || resultSet.wasNull()) {
            return new SpatialValue(null, null);
        }
        if (!(value instanceof Struct)) {
            if (value instanceof byte[] || value instanceof String) {
                SpatialValue decoded = EwkbWktDecoder.decodeSpatial(value);
                if (decoded.getWkt() != null && !decoded.getWkt().startsWith("0x")) {
                    return decoded;
                }
            }
            return JdbcExecutor.normalizeResultValue(value);
        }
        Struct struct = (Struct) value;
        Object[] attributes = struct.getAttributes();
        byte[] ewkb = attributes != null && attributes.length >= 2 ? geometryBytes(attributes[1]) : null;
        if (ewkb != null) {
            SpatialValue decoded = EwkbWktDecoder.decodeSpatial(ewkb);
            if (decoded.getWkt() != null && !decoded.getWkt().startsWith("0x")) {
                Integer srid = decoded.getSrid();
                if (srid == null && attributes.length > 0) {
                    srid = sridFromHeader(attributes[0]);
                }
                return new SpatialValue(decoded.getWkt(), srid);
            }
        }
        return normalizeStructuredValue(struct);
    }

    private static byte[] geometryBytes(Object attribute) throws SQLException {
        if (attribute instanceof byte[]) {
            byte[] bytes = (byte[]) attribute;
            return bytes.length == 0 || bytes.length > MAX_GEOMETRY_BYTES ? null : bytes;
        }
        if (attribute instanceof Blob) {
            Blob blob = (Blob) attribute;
            long length = blob.length();
            if (length <= 0 || length > MAX_GEOMETRY_BYTES) {
                return null;
            }
            return blob.getBytes(1, (int) length);
        }
        return null;
    }

    /**
     * YashanDB's 40-byte geometry header is
     * {@code version(1) endian(1) type(2) srid(4, endian-aware) bbox(4 doubles)}.
     * EWKB normally already carries the SRID; this is a fallback for payloads
     * that omit it.
     */
    private static Integer sridFromHeader(Object attribute) {
        if (!(attribute instanceof byte[])) {
            return null;
        }
        byte[] header = (byte[]) attribute;
        if (header.length < 8) {
            return null;
        }
        long srid;
        if (header[1] == 0) {
            srid = ((long) (header[4] & 0xFF) << 24)
                | ((long) (header[5] & 0xFF) << 16)
                | ((long) (header[6] & 0xFF) << 8)
                | (long) (header[7] & 0xFF);
        } else {
            srid = ((long) (header[7] & 0xFF) << 24)
                | ((long) (header[6] & 0xFF) << 16)
                | ((long) (header[5] & 0xFF) << 8)
                | (long) (header[4] & 0xFF);
        }
        return srid == 0 || srid > Integer.MAX_VALUE ? null : (int) srid;
    }

    private static boolean isStGeometryType(String columnTypeName) {
        if (columnTypeName == null) {
            return false;
        }
        String normalized = columnTypeName.trim().toUpperCase(Locale.ROOT);
        int parameter = normalized.indexOf('(');
        if (parameter >= 0) {
            normalized = normalized.substring(0, parameter).trim();
        }
        int qualifier = normalized.lastIndexOf('.');
        if (qualifier >= 0) {
            normalized = normalized.substring(qualifier + 1);
        }
        return "ST_GEOMETRY".equals(normalized);
    }

    private static String normalizeStructuredValue(Struct value) throws SQLException {
        Set<Struct> visited = Collections.newSetFromMap(new IdentityHashMap<>());
        return normalizeStructuredValue(value, visited, 0);
    }

    private static String normalizeStructuredValue(Struct value, Set<Struct> visited, int depth) throws SQLException {
        String typeName = value.getSQLTypeName();
        String displayType = typeName == null || typeName.isBlank() ? "STRUCT" : typeName;
        if (depth >= MAX_STRUCT_DEPTH) {
            return displayType + "(<max-depth>)";
        }
        if (!visited.add(value)) {
            return displayType + "(<cycle>)";
        }
        try {
            StringBuilder result = new StringBuilder(displayType).append('(');
            Object[] attributes = value.getAttributes();
            if (attributes != null) {
                for (int i = 0; i < attributes.length; i++) {
                    if (i > 0) {
                        result.append(", ");
                    }
                    Object attribute = attributes[i];
                    Object normalized = attribute instanceof Struct
                        ? normalizeStructuredValue((Struct) attribute, visited, depth + 1)
                        : JdbcExecutor.normalizeResultValue(attribute);
                    result.append(normalized);
                }
            }
            return result.append(')').toString();
        } finally {
            visited.remove(value);
        }
    }

    private static boolean isStructuredValue(int sqlType, String columnTypeName) {
        if (sqlType == Types.STRUCT) {
            return true;
        }
        if (columnTypeName == null) {
            return false;
        }
        String normalized = columnTypeName.trim().toUpperCase(Locale.ROOT);
        int qualifier = normalized.lastIndexOf('.');
        if (qualifier >= 0) {
            normalized = normalized.substring(qualifier + 1);
        }
        return "ST_GEOMETRY".equals(normalized);
    }

    @Override
    public ObjectSource getObjectSource(String schema, String name, String objectType) {
        String normalizedObjectType = normalizeObjectSourceType(objectType);
        return unchecked(() -> {
            StringBuilder source = new StringBuilder();
            try (PreparedStatement statement = requireConnection().prepareStatement(OBJECT_SOURCE_SQL)) {
                statement.setString(1, schema);
                statement.setString(2, name);
                statement.setString(3, normalizedObjectType);
                try (ResultSet resultSet = statement.executeQuery()) {
                    while (resultSet.next()) {
                        String line = resultSet.getString(1);
                        if (line != null) {
                            source.append(line);
                        }
                    }
                }
            }
            return new ObjectSource(name, normalizedObjectType, schema, source.toString(), false);
        });
    }

    static String normalizeObjectSourceType(String objectType) {
        if (objectType == null) {
            throw new IllegalArgumentException("Unsupported object type: null");
        }
        String normalized = objectType.trim().toUpperCase(Locale.ROOT);
        if (!"FUNCTION".equals(normalized) && !"PROCEDURE".equals(normalized)) {
            throw new IllegalArgumentException("Unsupported object type: " + objectType);
        }
        return normalized;
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(YashandbAgent::new).run();
    }
}
