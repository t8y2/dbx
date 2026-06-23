package com.dbx.agent;

import com.google.gson.annotations.SerializedName;

public enum CompletionAssistantCandidateKind {
    @SerializedName("database")
    DATABASE,
    @SerializedName("schema")
    SCHEMA,
    @SerializedName("table")
    TABLE,
    @SerializedName("view")
    VIEW,
    @SerializedName("procedure")
    PROCEDURE,
    @SerializedName("function")
    FUNCTION,
    @SerializedName("column")
    COLUMN,
    @SerializedName("object")
    OBJECT
}
