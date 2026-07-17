package com.dbx.agent;

import java.util.Objects;

public final class DatabaseInfo {
    private String name;

    public DatabaseInfo() {
        this("");
    }

    public DatabaseInfo(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof DatabaseInfo)) return false;
        DatabaseInfo that = (DatabaseInfo) other;
        return Objects.equals(name, that.name);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name);
    }

    @Override
    public String toString() {
        return "DatabaseInfo(name=" + name + ")";
    }
}
