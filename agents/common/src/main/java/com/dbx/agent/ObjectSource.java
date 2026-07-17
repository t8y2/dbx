package com.dbx.agent;

import java.util.Objects;

public final class ObjectSource {
    private String name;
    private String object_type;
    private String schema;
    private String source;
    private boolean editable;

    public ObjectSource() {
        this("", "", null, "", true);
    }

    public ObjectSource(String name, String object_type, String source) {
        this(name, object_type, null, source, true);
    }

    public ObjectSource(String name, String object_type, String schema, String source) {
        this(name, object_type, schema, source, true);
    }

    public ObjectSource(String name, String object_type, String schema, String source, boolean editable) {
        this.name = name;
        this.object_type = object_type;
        this.schema = schema;
        this.source = source;
        this.editable = editable;
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

    public String getSource() {
        return source;
    }

    public boolean isEditable() {
        return editable;
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

    public void setSource(String source) {
        this.source = source;
    }

    public void setEditable(boolean editable) {
        this.editable = editable;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ObjectSource)) return false;
        ObjectSource that = (ObjectSource) other;
        return Objects.equals(name, that.name)
            && Objects.equals(object_type, that.object_type)
            && Objects.equals(schema, that.schema)
            && Objects.equals(source, that.source)
            && editable == that.editable;
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, object_type, schema, source, editable);
    }

    @Override
    public String toString() {
        return "ObjectSource(name=" + name
            + ", object_type=" + object_type
            + ", schema=" + schema
            + ", source=" + source
            + ", editable=" + editable
            + ")";
    }
}
