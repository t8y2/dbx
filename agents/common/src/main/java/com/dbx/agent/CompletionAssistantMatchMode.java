package com.dbx.agent;

import com.google.gson.annotations.SerializedName;

public enum CompletionAssistantMatchMode {
    @SerializedName("prefix")
    PREFIX,
    @SerializedName("contains")
    CONTAINS
}
