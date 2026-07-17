package com.dbx.agent;

import com.google.gson.annotations.SerializedName;

public enum CompletionAssistantObjectKind {
    @SerializedName("database")
    DATABASE,
    @SerializedName("schema")
    SCHEMA,
    @SerializedName("table")
    TABLE,
    @SerializedName("view")
    VIEW,
    @SerializedName("routine")
    ROUTINE,
    @SerializedName("procedure")
    PROCEDURE,
    @SerializedName("function")
    FUNCTION,
    @SerializedName("column")
    COLUMN
}
