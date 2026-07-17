package com.dbx.agent;

import java.util.Objects;

public final class ForeignKeyInfo {
    private String name;
    private String column;
    private String ref_table;
    private String ref_column;

    public ForeignKeyInfo() {
        this("", "", "", "");
    }

    public ForeignKeyInfo(String name, String column, String ref_table, String ref_column) {
        this.name = name;
        this.column = column;
        this.ref_table = ref_table;
        this.ref_column = ref_column;
    }

    public String getName() {
        return name;
    }

    public String getColumn() {
        return column;
    }

    public String getRef_table() {
        return ref_table;
    }

    public String getRef_column() {
        return ref_column;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void setColumn(String column) {
        this.column = column;
    }

    public void setRef_table(String ref_table) {
        this.ref_table = ref_table;
    }

    public void setRef_column(String ref_column) {
        this.ref_column = ref_column;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ForeignKeyInfo)) return false;
        ForeignKeyInfo that = (ForeignKeyInfo) other;
        return Objects.equals(name, that.name)
            && Objects.equals(column, that.column)
            && Objects.equals(ref_table, that.ref_table)
            && Objects.equals(ref_column, that.ref_column);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, column, ref_table, ref_column);
    }

    @Override
    public String toString() {
        return "ForeignKeyInfo(name=" + name
            + ", column=" + column
            + ", ref_table=" + ref_table
            + ", ref_column=" + ref_column
            + ")";
    }
}
