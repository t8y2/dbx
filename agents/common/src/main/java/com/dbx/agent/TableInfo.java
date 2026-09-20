package com.dbx.agent;

import java.util.Objects;

public final class TableInfo {
    private String name;
    private String table_type;
    private String comment;
    private String parent_schema;
    private String parent_name;
    private Boolean valid;

    public TableInfo() {
        this("", "", null);
    }

    public TableInfo(String name, String table_type) {
        this(name, table_type, null);
    }

    public TableInfo(String name, String table_type, String comment) {
        this(name, table_type, comment, null, null);
    }

    public TableInfo(String name, String table_type, String comment, String parent_schema, String parent_name) {
        this(name, table_type, comment, parent_schema, parent_name, null);
    }

    public TableInfo(String name, String table_type, String comment, String parent_schema, String parent_name, Boolean valid) {
        this.name = name;
        this.table_type = table_type;
        this.comment = comment;
        this.parent_schema = parent_schema;
        this.parent_name = parent_name;
        this.valid = valid;
    }

    public String getName() {
        return name;
    }

    public String getTable_type() {
        return table_type;
    }

    public String getComment() {
        return comment;
    }

    public String getParent_schema() {
        return parent_schema;
    }

    public String getParent_name() {
        return parent_name;
    }

    public Boolean getValid() {
        return valid;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void setTable_type(String table_type) {
        this.table_type = table_type;
    }

    public void setComment(String comment) {
        this.comment = comment;
    }

    public void setParent_schema(String parent_schema) {
        this.parent_schema = parent_schema;
    }

    public void setParent_name(String parent_name) {
        this.parent_name = parent_name;
    }

    public void setValid(Boolean valid) {
        this.valid = valid;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof TableInfo)) return false;
        TableInfo that = (TableInfo) other;
        return Objects.equals(name, that.name)
            && Objects.equals(table_type, that.table_type)
            && Objects.equals(comment, that.comment)
            && Objects.equals(parent_schema, that.parent_schema)
            && Objects.equals(parent_name, that.parent_name)
            && Objects.equals(valid, that.valid);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, table_type, comment, parent_schema, parent_name, valid);
    }

    @Override
    public String toString() {
        return "TableInfo(name=" + name
            + ", table_type=" + table_type
            + ", comment=" + comment
            + ", parent_schema=" + parent_schema
            + ", parent_name=" + parent_name
            + ", valid=" + valid
            + ")";
    }
}
