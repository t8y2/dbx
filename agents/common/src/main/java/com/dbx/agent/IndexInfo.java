package com.dbx.agent;

import java.util.Collections;
import java.util.List;
import java.util.Objects;

public final class IndexInfo {
    private String name;
    private List<String> columns;
    private boolean is_unique;
    private boolean is_primary;
    private String filter;
    private String index_type;
    private List<String> included_columns;
    private String comment;
    // Parallel to `columns`: true at index i means columns[i] is a raw expression (e.g. sourced
    // from pg_get_indexdef), not a plain column name. Empty when the introspection source
    // doesn't track this (provenance unknown for that dialect/path). Mirrors
    // crate::types::IndexInfo::key_is_expression on the Rust side (#6312 review).
    private List<Boolean> key_is_expression;

    public IndexInfo() {
        this("", Collections.emptyList(), false, false);
    }

    public IndexInfo(String name, List<String> columns, boolean is_unique, boolean is_primary) {
        this(name, columns, is_unique, is_primary, null, null, null, null, Collections.emptyList());
    }

    public IndexInfo(
        String name,
        List<String> columns,
        boolean is_unique,
        boolean is_primary,
        String filter,
        String index_type,
        List<String> included_columns,
        String comment
    ) {
        this(name, columns, is_unique, is_primary, filter, index_type, included_columns, comment, Collections.emptyList());
    }

    public IndexInfo(
        String name,
        List<String> columns,
        boolean is_unique,
        boolean is_primary,
        String filter,
        String index_type,
        List<String> included_columns,
        String comment,
        List<Boolean> key_is_expression
    ) {
        this.name = name;
        this.columns = columns == null ? Collections.emptyList() : columns;
        this.is_unique = is_unique;
        this.is_primary = is_primary;
        this.filter = filter;
        this.index_type = index_type;
        this.included_columns = included_columns;
        this.comment = comment;
        this.key_is_expression = key_is_expression == null ? Collections.emptyList() : key_is_expression;
    }

    public String getName() {
        return name;
    }

    public List<String> getColumns() {
        return columns;
    }

    public boolean getIs_unique() {
        return is_unique;
    }

    public boolean getIs_primary() {
        return is_primary;
    }

    public String getFilter() {
        return filter;
    }

    public String getIndex_type() {
        return index_type;
    }

    public List<String> getIncluded_columns() {
        return included_columns;
    }

    public String getComment() {
        return comment;
    }

    public List<Boolean> getKey_is_expression() {
        return key_is_expression;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void setColumns(List<String> columns) {
        this.columns = columns;
    }

    public void setIs_unique(boolean is_unique) {
        this.is_unique = is_unique;
    }

    public void setIs_primary(boolean is_primary) {
        this.is_primary = is_primary;
    }

    public void setFilter(String filter) {
        this.filter = filter;
    }

    public void setIndex_type(String index_type) {
        this.index_type = index_type;
    }

    public void setIncluded_columns(List<String> included_columns) {
        this.included_columns = included_columns;
    }

    public void setComment(String comment) {
        this.comment = comment;
    }

    public void setKey_is_expression(List<Boolean> key_is_expression) {
        this.key_is_expression = key_is_expression;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof IndexInfo)) return false;
        IndexInfo that = (IndexInfo) other;
        return is_unique == that.is_unique
            && is_primary == that.is_primary
            && Objects.equals(name, that.name)
            && Objects.equals(columns, that.columns)
            && Objects.equals(filter, that.filter)
            && Objects.equals(index_type, that.index_type)
            && Objects.equals(included_columns, that.included_columns)
            && Objects.equals(comment, that.comment)
            && Objects.equals(key_is_expression, that.key_is_expression);
    }

    @Override
    public int hashCode() {
        return Objects.hash(
            name, columns, is_unique, is_primary, filter, index_type, included_columns, comment, key_is_expression
        );
    }

    @Override
    public String toString() {
        return "IndexInfo(name=" + name
            + ", columns=" + columns
            + ", is_unique=" + is_unique
            + ", is_primary=" + is_primary
            + ", filter=" + filter
            + ", index_type=" + index_type
            + ", included_columns=" + included_columns
            + ", comment=" + comment
            + ", key_is_expression=" + key_is_expression
            + ")";
    }
}
