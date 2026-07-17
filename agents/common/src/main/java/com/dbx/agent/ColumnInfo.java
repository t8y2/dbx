package com.dbx.agent;

import java.util.Objects;

public final class ColumnInfo {
    private String name;
    private String data_type;
    private boolean is_nullable;
    private String column_default;
    private boolean is_primary_key;
    private String extra;
    private String comment;
    private Integer numeric_precision;
    private Integer numeric_scale;
    private Integer character_maximum_length;

    public ColumnInfo() {
        this("", "", true, null, false);
    }

    public ColumnInfo(String name, String data_type, boolean is_nullable, String column_default, boolean is_primary_key) {
        this(name, data_type, is_nullable, column_default, is_primary_key, null, null, null, null, null);
    }

    public ColumnInfo(
        String name,
        String data_type,
        boolean is_nullable,
        String column_default,
        boolean is_primary_key,
        String extra,
        String comment,
        Integer numeric_precision,
        Integer numeric_scale,
        Integer character_maximum_length
    ) {
        this.name = name;
        this.data_type = data_type;
        this.is_nullable = is_nullable;
        this.column_default = column_default;
        this.is_primary_key = is_primary_key;
        this.extra = extra;
        this.comment = comment;
        this.numeric_precision = numeric_precision;
        this.numeric_scale = numeric_scale;
        this.character_maximum_length = character_maximum_length;
    }

    public String getName() {
        return name;
    }

    public String getData_type() {
        return data_type;
    }

    public boolean getIs_nullable() {
        return is_nullable;
    }

    public String getColumn_default() {
        return column_default;
    }

    public boolean getIs_primary_key() {
        return is_primary_key;
    }

    public String getExtra() {
        return extra;
    }

    public String getComment() {
        return comment;
    }

    public Integer getNumeric_precision() {
        return numeric_precision;
    }

    public Integer getNumeric_scale() {
        return numeric_scale;
    }

    public Integer getCharacter_maximum_length() {
        return character_maximum_length;
    }

    public void setName(String name) {
        this.name = name;
    }

    public void setData_type(String data_type) {
        this.data_type = data_type;
    }

    public void setIs_nullable(boolean is_nullable) {
        this.is_nullable = is_nullable;
    }

    public void setColumn_default(String column_default) {
        this.column_default = column_default;
    }

    public void setIs_primary_key(boolean is_primary_key) {
        this.is_primary_key = is_primary_key;
    }

    public void setExtra(String extra) {
        this.extra = extra;
    }

    public void setComment(String comment) {
        this.comment = comment;
    }

    public void setNumeric_precision(Integer numeric_precision) {
        this.numeric_precision = numeric_precision;
    }

    public void setNumeric_scale(Integer numeric_scale) {
        this.numeric_scale = numeric_scale;
    }

    public void setCharacter_maximum_length(Integer character_maximum_length) {
        this.character_maximum_length = character_maximum_length;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof ColumnInfo)) return false;
        ColumnInfo that = (ColumnInfo) other;
        return is_nullable == that.is_nullable
            && is_primary_key == that.is_primary_key
            && Objects.equals(name, that.name)
            && Objects.equals(data_type, that.data_type)
            && Objects.equals(column_default, that.column_default)
            && Objects.equals(extra, that.extra)
            && Objects.equals(comment, that.comment)
            && Objects.equals(numeric_precision, that.numeric_precision)
            && Objects.equals(numeric_scale, that.numeric_scale)
            && Objects.equals(character_maximum_length, that.character_maximum_length);
    }

    @Override
    public int hashCode() {
        return Objects.hash(
            name,
            data_type,
            is_nullable,
            column_default,
            is_primary_key,
            extra,
            comment,
            numeric_precision,
            numeric_scale,
            character_maximum_length
        );
    }

    @Override
    public String toString() {
        return "ColumnInfo(name=" + name
            + ", data_type=" + data_type
            + ", is_nullable=" + is_nullable
            + ", column_default=" + column_default
            + ", is_primary_key=" + is_primary_key
            + ", extra=" + extra
            + ", comment=" + comment
            + ", numeric_precision=" + numeric_precision
            + ", numeric_scale=" + numeric_scale
            + ", character_maximum_length=" + character_maximum_length
            + ")";
    }
}
