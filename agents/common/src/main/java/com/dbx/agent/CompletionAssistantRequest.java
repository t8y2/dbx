package com.dbx.agent;

import java.util.ArrayList;
import java.util.List;

public final class CompletionAssistantRequest {
    private String connection_id;
    private String database;
    private String schema;
    private List<CompletionAssistantObjectKind> object_kinds = new ArrayList<>();
    private String mask = "";
    private boolean case_sensitive;
    private boolean global_search;
    private Integer max_results;
    private boolean search_in_comments;
    private boolean search_in_definitions;
    private String parent_schema;
    private String parent_name;
    private CompletionAssistantMatchMode match_mode;

    public String getConnection_id() { return connection_id; }
    public String getDatabase() { return database == null ? "" : database; }
    public String getSchema() { return schema; }
    public List<CompletionAssistantObjectKind> getObject_kinds() { return object_kinds == null ? new ArrayList<>() : object_kinds; }
    public String getMask() { return mask == null ? "" : mask; }
    public boolean getCase_sensitive() { return case_sensitive; }
    public boolean getGlobal_search() { return global_search; }
    public Integer getMax_results() { return max_results; }
    public boolean getSearch_in_comments() { return search_in_comments; }
    public boolean getSearch_in_definitions() { return search_in_definitions; }
    public String getParent_schema() { return parent_schema; }
    public String getParent_name() { return parent_name; }
    public CompletionAssistantMatchMode getMatch_mode() { return match_mode; }
}
