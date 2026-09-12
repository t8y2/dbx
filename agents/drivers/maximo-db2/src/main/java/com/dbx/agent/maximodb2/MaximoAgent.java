package com.dbx.agent.maximodb2;

import com.dbx.agent.ColumnInfo;
import com.dbx.agent.ConnectParams;
import com.dbx.agent.MultiSessionJsonRpcServer;
import com.dbx.agent.db2.Db2Agent;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * IBM Maximo (DB2 backend) agent.
 *
 * <p>Reuses every {@link Db2Agent} metadata query and only specializes
 * {@link #getColumns(String, String)}: after the regular column metadata is
 * loaded, each column is enriched with the business display title stored in
 * Maximo's {@code MAXATTRIBUTE.TITLE} column (matched by {@code OBJECTNAME}).
 * The dedicated connection profile selects this agent, so no database-name
 * probing is required at runtime.
 */
public final class MaximoAgent extends Db2Agent {
    private static final long CACHE_TTL_MILLIS = 10 * 60 * 1000L;
    private static final long FAILURE_TTL_MILLIS = 60 * 1000L;
    private static final String PLACEHOLDER_TITLE = "~null~";

    private final Map<String, CacheEntry> titleCache = new ConcurrentHashMap<>();

    @Override
    public List<ColumnInfo> getColumns(String schema, String table) {
        List<ColumnInfo> columns = super.getColumns(schema, table);
        if (columns.isEmpty()) {
            return columns;
        }
        Map<String, String> titles = attributeTitles(table, titleLanguage());
        if (titles.isEmpty()) {
            return columns;
        }
        for (ColumnInfo column : columns) {
            String current = column.getTitle();
            if (current != null && !current.isEmpty()) {
                continue;
            }
            String title = titles.get(column.getName().trim().toUpperCase(Locale.ROOT));
            if (title != null) {
                column.setTitle(title);
            }
        }
        return columns;
    }

    /**
     * Resolves the requested title language from the connection options. An empty
     * value means "use the Maximo base language" (MAXATTRIBUTE.TITLE).
     */
    private String titleLanguage() {
        ConnectParams params = currentConnectParams();
        String language = params == null ? null : params.getMaximo_title_language();
        if (language == null) {
            return "";
        }
        return language.trim().toUpperCase(Locale.ROOT);
    }

    private Map<String, String> attributeTitles(String table, String language) {
        String tableKey = table == null ? "" : table.trim();
        if (tableKey.isEmpty()) {
            return Map.of();
        }
        String langKey = language == null ? "" : language;
        String cacheKey = langKey + "\u0000" + tableKey;
        long now = System.currentTimeMillis();
        CacheEntry cached = titleCache.get(cacheKey);
        if (cached != null) {
            long ttl = cached.titles.isEmpty() ? FAILURE_TTL_MILLIS : CACHE_TTL_MILLIS;
            if (now - cached.fetchedAt < ttl) {
                return cached.titles;
            }
        }
        Map<String, String> titles = loadAttributeTitles(tableKey, langKey);
        titleCache.put(cacheKey, new CacheEntry(now, titles));
        return titles;
    }

    /**
     * Tries the schema-qualified Maximo table (MAXIMO.MAXATTRIBUTE) first and
     * falls back to the bare table name, and tries the original table name
     * before its upper-case form (quoted/mixed-case tables). When a non-base
     * language is requested the localized L_MAXATTRIBUTE table is joined.
     */
    private Map<String, String> loadAttributeTitles(String table, String language) {
        List<String> tableRefs = List.of("MAXIMO.MAXATTRIBUTE", "MAXATTRIBUTE");
        List<String> tableNames = new ArrayList<>();
        tableNames.add(table);
        String upper = table.toUpperCase(Locale.ROOT);
        if (!upper.equals(table)) {
            tableNames.add(upper);
        }
        for (String tableRef : tableRefs) {
            for (String tableName : tableNames) {
                Map<String, String> titles = queryAttributeTitles(tableRef, tableName, language);
                if (titles != null) {
                    return titles;
                }
            }
        }
        return Map.of();
    }

    private Map<String, String> queryAttributeTitles(String tableRef, String tableName, String language) {
        boolean localized = language != null && !language.isEmpty();
        String sql;
        if (localized) {
            sql = "SELECT a.ATTRIBUTENAME, l.TITLE, a.TITLE FROM " + tableRef + " a"
                + " LEFT JOIN " + localizedTableRef(tableRef) + " l"
                + " ON a.MAXATTRIBUTEID = l.OWNERID AND l.LANGCODE = ?"
                + " WHERE a.OBJECTNAME = ?";
        } else {
            sql = "SELECT ATTRIBUTENAME, TITLE FROM " + tableRef + " WHERE OBJECTNAME = ? AND TITLE IS NOT NULL";
        }
        try (PreparedStatement stmt = requireConnected().prepareStatement(sql)) {
            stmt.setQueryTimeout(15);
            if (localized) {
                stmt.setString(1, language);
                stmt.setString(2, tableName);
            } else {
                stmt.setString(1, tableName);
            }
            try (ResultSet rs = stmt.executeQuery()) {
                Map<String, String> titles = new HashMap<>();
                while (rs.next()) {
                    String attribute = rs.getString(1);
                    if (attribute == null) {
                        continue;
                    }
                    String attributeName = attribute.trim();
                    if (attributeName.isEmpty()) {
                        continue;
                    }
                    String title = localized
                        ? firstUsableTitle(rs.getString(2), rs.getString(3))
                        : usableTitle(rs.getString(2));
                    if (title != null) {
                        titles.putIfAbsent(attributeName.toUpperCase(Locale.ROOT), title);
                    }
                }
                return titles;
            }
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String localizedTableRef(String tableRef) {
        String suffix = "MAXATTRIBUTE";
        if (tableRef.endsWith(suffix)) {
            return tableRef.substring(0, tableRef.length() - suffix.length()) + "L_MAXATTRIBUTE";
        }
        return "L_MAXATTRIBUTE";
    }

    private static String firstUsableTitle(String preferred, String fallback) {
        String value = usableTitle(preferred);
        return value != null ? value : usableTitle(fallback);
    }

    private static String usableTitle(String title) {
        if (title == null) {
            return null;
        }
        String trimmed = title.trim();
        if (trimmed.isEmpty() || trimmed.equalsIgnoreCase(PLACEHOLDER_TITLE)) {
            return null;
        }
        return trimmed;
    }

    private static final class CacheEntry {
        private final long fetchedAt;
        private final Map<String, String> titles;

        private CacheEntry(long fetchedAt, Map<String, String> titles) {
            this.fetchedAt = fetchedAt;
            this.titles = titles;
        }
    }

    public static void main(String[] args) {
        new MultiSessionJsonRpcServer(MaximoAgent::new).run();
    }
}
