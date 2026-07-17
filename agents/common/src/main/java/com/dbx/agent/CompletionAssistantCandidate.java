package com.dbx.agent;

public final class CompletionAssistantCandidate {
    private final String name;
    private final CompletionAssistantCandidateKind kind;
    private final String database;
    private final String schema;
    private final String parent_schema;
    private final String parent_name;
    private final String comment;
    private final String data_type;

    public CompletionAssistantCandidate(
        String name,
        CompletionAssistantCandidateKind kind,
        String database,
        String schema,
        String parentSchema,
        String parentName,
        String comment,
        String dataType
    ) {
        this.name = name;
        this.kind = kind;
        this.database = database;
        this.schema = schema;
        this.parent_schema = parentSchema;
        this.parent_name = parentName;
        this.comment = comment;
        this.data_type = dataType;
    }

    public String getName() { return name; }
    public CompletionAssistantCandidateKind getKind() { return kind; }
    public String getDatabase() { return database; }
    public String getSchema() { return schema; }
    public String getParent_schema() { return parent_schema; }
    public String getParent_name() { return parent_name; }
    public String getComment() { return comment; }
    public String getData_type() { return data_type; }
}
