package com.dbx.agent;

import java.util.Objects;

public final class QueryPageParams {
    private String sql;
    private String schema;
    private Integer pageSize;
    private Integer fetchSize;
    private Integer maxRows;

    public QueryPageParams() {
        this("", null, null, null, null);
    }

    public QueryPageParams(String sql, String schema, Integer pageSize, Integer fetchSize, Integer maxRows) {
        this.sql = sql;
        this.schema = schema;
        this.pageSize = pageSize;
        this.fetchSize = fetchSize;
        this.maxRows = maxRows;
    }

    public String getSql() {
        return sql;
    }

    public String getSchema() {
        return schema;
    }

    public Integer getPageSize() {
        return pageSize;
    }

    public Integer getFetchSize() {
        return fetchSize;
    }

    public Integer getMaxRows() {
        return maxRows;
    }

    public void setSql(String sql) {
        this.sql = sql;
    }

    public void setSchema(String schema) {
        this.schema = schema;
    }

    public void setPageSize(Integer pageSize) {
        this.pageSize = pageSize;
    }

    public void setFetchSize(Integer fetchSize) {
        this.fetchSize = fetchSize;
    }

    public void setMaxRows(Integer maxRows) {
        this.maxRows = maxRows;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof QueryPageParams)) return false;
        QueryPageParams that = (QueryPageParams) other;
        return Objects.equals(sql, that.sql)
            && Objects.equals(schema, that.schema)
            && Objects.equals(pageSize, that.pageSize)
            && Objects.equals(fetchSize, that.fetchSize)
            && Objects.equals(maxRows, that.maxRows);
    }

    @Override
    public int hashCode() {
        return Objects.hash(sql, schema, pageSize, fetchSize, maxRows);
    }

    @Override
    public String toString() {
        return "QueryPageParams(sql=" + sql
            + ", schema=" + schema
            + ", pageSize=" + pageSize
            + ", fetchSize=" + fetchSize
            + ", maxRows=" + maxRows
            + ")";
    }
}
