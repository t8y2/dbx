package com.dbx.agent;

import java.util.Objects;

public final class ExecuteQueryOptions {
    private int maxRows;
    private Integer fetchSize;
    private int timeoutSecs;

    public ExecuteQueryOptions() {
        this(JdbcExecutor.DEFAULT_MAX_ROWS, null, 0);
    }

    public ExecuteQueryOptions(int maxRows, Integer fetchSize) {
        this(maxRows, fetchSize, 0);
    }

    public ExecuteQueryOptions(int maxRows, Integer fetchSize, int timeoutSecs) {
        this.maxRows = maxRows;
        this.fetchSize = fetchSize;
        this.timeoutSecs = timeoutSecs;
    }

    public int getMaxRows() {
        return maxRows;
    }

    public Integer getFetchSize() {
        return fetchSize;
    }

    public int getTimeoutSecs() {
        return timeoutSecs;
    }

    public void setMaxRows(int maxRows) {
        this.maxRows = maxRows;
    }

    public void setFetchSize(Integer fetchSize) {
        this.fetchSize = fetchSize;
    }

    public void setTimeoutSecs(int timeoutSecs) {
        this.timeoutSecs = timeoutSecs;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ExecuteQueryOptions)) return false;
        ExecuteQueryOptions that = (ExecuteQueryOptions) other;
        return maxRows == that.maxRows
            && timeoutSecs == that.timeoutSecs
            && Objects.equals(fetchSize, that.fetchSize);
    }

    @Override
    public int hashCode() {
        return Objects.hash(maxRows, fetchSize, timeoutSecs);
    }

    @Override
    public String toString() {
        return "ExecuteQueryOptions(maxRows=" + maxRows + ", fetchSize=" + fetchSize + ", timeoutSecs=" + timeoutSecs + ")";
    }
}
