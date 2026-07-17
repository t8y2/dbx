package com.dbx.agent;

import java.util.Objects;

public final class ExecuteQueryParams {
    private String sql;
    private String schema;
    private Integer maxRows;
    private Integer fetchSize;

    public ExecuteQueryParams() {
        this("", null, null, null);
    }

    public ExecuteQueryParams(String sql, String schema, Integer maxRows, Integer fetchSize) {
        this.sql = sql;
        this.schema = schema;
        this.maxRows = maxRows;
        this.fetchSize = fetchSize;
    }

    public String getSql() {
        return sql;
    }

    public String getSchema() {
        return schema;
    }

    public Integer getMaxRows() {
        return maxRows;
    }

    public Integer getFetchSize() {
        return fetchSize;
    }

    public void setSql(String sql) {
        this.sql = sql;
    }

    public void setSchema(String schema) {
        this.schema = schema;
    }

    public void setMaxRows(Integer maxRows) {
        this.maxRows = maxRows;
    }

    public void setFetchSize(Integer fetchSize) {
        this.fetchSize = fetchSize;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ExecuteQueryParams)) return false;
        ExecuteQueryParams that = (ExecuteQueryParams) other;
        return Objects.equals(sql, that.sql)
            && Objects.equals(schema, that.schema)
            && Objects.equals(maxRows, that.maxRows)
            && Objects.equals(fetchSize, that.fetchSize);
    }

    @Override
    public int hashCode() {
        return Objects.hash(sql, schema, maxRows, fetchSize);
    }

    @Override
    public String toString() {
        return "ExecuteQueryParams(sql=" + sql
            + ", schema=" + schema
            + ", maxRows=" + maxRows
            + ", fetchSize=" + fetchSize
            + ")";
    }
}
