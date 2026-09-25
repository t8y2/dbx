package com.dbx.agent;

import java.util.Objects;

public final class ObjectInfo {
    private String name;
    private String object_type;
    private String schema;
    private String comment;
    private Boolean valid;

    public ObjectInfo() {
        this("", "", null, null, null);
    }

    public ObjectInfo(String name, String object_type) {
        this(name, object_type, null, null);
    }

    public ObjectInfo(String name, String object_type, String schema, String comment) {
        this(name, object_type, schema, comment, null);
    }

    public ObjectInfo(String name, String object_type, String schema, String comment, Boolean valid) {
        this.name = name;
        this.object_type = object_type;
        this.schema = schema;
        this.comment = comment;
        this.valid = valid;
    }

    public String getName() {
        return name;
    }

    public String getObject_type() {
        return object_type;
    }

    public String getSchema() {
        return schema;
    }

    public String getComment() {
        return comment;
    }

    public Boolean getValid() {
        return valid;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void setObject_type(String object_type) {
        this.object_type = object_type;
    }

    public void setSchema(String schema) {
        this.schema = schema;
    }

    public void setComment(String comment) {
        this.comment = comment;
    }

    public void setValid(Boolean valid) {
        this.valid = valid;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ObjectInfo)) return false;
        ObjectInfo that = (ObjectInfo) other;
        return Objects.equals(name, that.name)
            && Objects.equals(object_type, that.object_type)
            && Objects.equals(schema, that.schema)
            && Objects.equals(comment, that.comment)
            && Objects.equals(valid, that.valid);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, object_type, schema, comment, valid);
    }

    @Override
    public String toString() {
        return "ObjectInfo(name=" + name
            + ", object_type=" + object_type
            + ", schema=" + schema
            + ", comment=" + comment
            + ", valid=" + valid
            + ")";
    }
}
