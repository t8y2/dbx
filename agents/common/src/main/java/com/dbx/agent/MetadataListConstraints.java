package com.dbx.agent;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public final class MetadataListConstraints {
    public static final MetadataListConstraints NONE = new MetadataListConstraints(null, null, null, null);

    private final String filter;
    private final Integer limit;
    private final Integer offset;
    private final List<String> objectTypes;

    public MetadataListConstraints(String filter, Integer limit, Integer offset, List<String> objectTypes) {
        this.filter = normalizeFilter(filter);
        this.limit = limit == null || limit <= 0 ? null : limit;
        this.offset = offset == null || offset <= 0 ? null : offset;
        this.objectTypes = normalizeObjectTypes(objectTypes);
    }

    public static MetadataListConstraints orNone(MetadataListConstraints constraints) {
        return constraints == null ? NONE : constraints;
    }

    public String getFilter() {
        return filter;
    }

    public Integer getLimit() {
        return limit;
    }

    public Integer getOffset() {
        return offset;
    }

    public List<String> getObjectTypes() {
        return objectTypes.isEmpty() ? null : objectTypes;
    }

    public boolean hasFilter() {
        return !filter.isEmpty();
    }

    public boolean hasLimit() {
        return limit != null;
    }

    public boolean hasOffset() {
        return offset != null;
    }

    public boolean hasObjectTypes() {
        return !objectTypes.isEmpty();
    }

    public MetadataListConstraints withoutPaging() {
        return new MetadataListConstraints(filter, null, null, objectTypes);
    }

    public String fuzzyLikePattern() {
        if (filter.isEmpty()) {
            return "%%";
        }
        StringBuilder builder = new StringBuilder(filter.length() * 2 + 2);
        builder.append('%');
        for (int i = 0; i < filter.length(); i++) {
            char ch = filter.charAt(i);
            if (ch == '\\' || ch == '%' || ch == '_') {
                builder.append('\\');
            }
            builder.append(ch);
            builder.append('%');
        }
        return builder.toString();
    }

    public boolean includesTableLikeTypes() {
        if (objectTypes.isEmpty()) {
            return true;
        }
        return objectTypes.contains("TABLE")
            || objectTypes.contains("VIEW")
            || objectTypes.contains("MATERIALIZED_VIEW");
    }

    public boolean tableTypeAllowed(String tableType) {
        if (objectTypes.isEmpty()) {
            return true;
        }
        return objectTypes.contains(normalizeTableType(tableType));
    }

    public boolean objectTypeAllowed(String objectType) {
        if (objectTypes.isEmpty()) {
            return true;
        }
        String normalized = normalizeObjectType(objectType);
        return !normalized.isEmpty() && objectTypes.contains(normalized);
    }

    public boolean nameMatches(String name) {
        return textMatches(name);
    }

    public boolean nameOrCommentMatches(String name, String comment) {
        return textMatches(name) || textMatches(comment);
    }

    private boolean textMatches(String text) {
        if (filter.isEmpty()) {
            return true;
        }
        if (text == null) {
            return false;
        }
        String candidate = text.toLowerCase(Locale.ROOT);
        return candidate.contains(filter) || (filter.length() >= 2 && fuzzySubsequenceMatches(candidate, filter));
    }

    public List<TableInfo> filterTables(List<TableInfo> tables) {
        List<TableInfo> result = new ArrayList<>();
        int skipped = 0;
        int max = limit == null ? Integer.MAX_VALUE : limit;
        int start = offset == null ? 0 : offset;
        for (TableInfo table : tables) {
            if (!nameOrCommentMatches(table.getName(), table.getComment())
                || !tableTypeAllowed(table.getTable_type())) {
                continue;
            }
            if (skipped++ < start) {
                continue;
            }
            if (result.size() >= max) {
                break;
            }
            result.add(table);
        }
        return result;
    }

    public List<ObjectInfo> filterObjects(List<ObjectInfo> objects) {
        List<ObjectInfo> result = new ArrayList<>();
        int skipped = 0;
        int max = limit == null ? Integer.MAX_VALUE : limit;
        int start = offset == null ? 0 : offset;
        for (ObjectInfo object : objects) {
            if (!nameOrCommentMatches(object.getName(), object.getComment())
                || !objectTypeAllowed(object.getObject_type())) {
                continue;
            }
            if (skipped++ < start) {
                continue;
            }
            if (result.size() >= max) {
                break;
            }
            result.add(object);
        }
        return result;
    }

    private static String normalizeFilter(String value) {
        if (value == null) {
            return "";
        }
        return value.trim().toLowerCase(Locale.ROOT);
    }

    private static List<String> normalizeObjectTypes(List<String> values) {
        if (values == null || values.isEmpty()) {
            return Collections.emptyList();
        }
        List<String> result = new ArrayList<>();
        for (String value : values) {
            String normalized = normalizeObjectType(value);
            if (!normalized.isEmpty() && !result.contains(normalized)) {
                result.add(normalized);
            }
        }
        Collections.sort(result);
        return Collections.unmodifiableList(result);
    }

    private static String normalizeTableType(String value) {
        String normalized = normalizeObjectType(value);
        return normalized.isEmpty() ? "TABLE" : normalized;
    }

    private static String normalizeObjectType(String value) {
        if (value == null || value.trim().isEmpty()) {
            return "";
        }
        String upper = value.trim().toUpperCase(Locale.ROOT).replace(' ', '_');
        if (upper.contains("MATERIALIZED") && upper.contains("VIEW")) {
            return "MATERIALIZED_VIEW";
        }
        if (upper.equals("STABLE") || upper.equals("BASE_TABLE") || upper.contains("TABLE")) {
            return "TABLE";
        }
        if (upper.contains("VIEW")) {
            return "VIEW";
        }
        return upper;
    }

    private static boolean fuzzySubsequenceMatches(String candidate, String expected) {
        int cursor = 0;
        for (int i = 0; i < expected.length(); i++) {
            char ch = expected.charAt(i);
            cursor = candidate.indexOf(ch, cursor);
            if (cursor < 0) {
                return false;
            }
            cursor++;
        }
        return true;
    }
}
