package com.dbx.agent;

import java.util.Objects;

public final class ExecuteQueryOptions {
    private int maxRows;
    private Integer fetchSize;
    private int timeoutSecs;
    private boolean deferLobs;

    public ExecuteQueryOptions() {
        this(JdbcExecutor.DEFAULT_MAX_ROWS, null, 0, false);
    }

    public ExecuteQueryOptions(int maxRows, Integer fetchSize) {
        this(maxRows, fetchSize, 0, false);
    }

    public ExecuteQueryOptions(int maxRows, Integer fetchSize, int timeoutSecs) {
        this(maxRows, fetchSize, timeoutSecs, false);
    }

    public ExecuteQueryOptions(int maxRows, Integer fetchSize, int timeoutSecs, boolean deferLobs) {
        this.maxRows = maxRows;
        this.fetchSize = fetchSize;
        this.timeoutSecs = timeoutSecs;
        this.deferLobs = deferLobs;
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

    public boolean getDeferLobs() {
        return deferLobs;
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

    public void setDeferLobs(boolean deferLobs) {
        this.deferLobs = deferLobs;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ExecuteQueryOptions)) return false;
        ExecuteQueryOptions that = (ExecuteQueryOptions) other;
        return maxRows == that.maxRows
            && timeoutSecs == that.timeoutSecs
            && deferLobs == that.deferLobs
            && Objects.equals(fetchSize, that.fetchSize);
    }

    @Override
    public int hashCode() {
        return Objects.hash(maxRows, fetchSize, timeoutSecs, deferLobs);
    }

    @Override
    public String toString() {
        return "ExecuteQueryOptions(maxRows=" + maxRows + ", fetchSize=" + fetchSize + ", timeoutSecs=" + timeoutSecs + ", deferLobs=" + deferLobs + ")";
    }
}
