package com.dbx.agent;

import java.util.Objects;

public final class SchemaTableParams {
    private String schema;
    private String table;

    public SchemaTableParams() {
        this("", "");
    }

    public SchemaTableParams(String schema, String table) {
        this.schema = schema;
        this.table = table;
    }

    public String getSchema() {
        return schema;
    }

    public String getTable() {
        return table;
    }

    public void setSchema(String schema) {
        this.schema = schema;
    }

    public void setTable(String table) {
        this.table = table;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof SchemaTableParams)) return false;
        SchemaTableParams that = (SchemaTableParams) other;
        return Objects.equals(schema, that.schema) && Objects.equals(table, that.table);
    }

    @Override
    public int hashCode() {
        return Objects.hash(schema, table);
    }

    @Override
    public String toString() {
        return "SchemaTableParams(schema=" + schema + ", table=" + table + ")";
    }
}
