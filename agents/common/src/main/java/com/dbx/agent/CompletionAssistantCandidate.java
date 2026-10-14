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
    private final String signature;
    private final String routine_id;

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
        this(name, kind, database, schema, parentSchema, parentName, comment, dataType, null, null);
    }

    public CompletionAssistantCandidate(
        String name,
        CompletionAssistantCandidateKind kind,
        String database,
        String schema,
        String parentSchema,
        String parentName,
        String comment,
        String dataType,
        String signature,
        String routineId
    ) {
        this.name = name;
        this.kind = kind;
        this.database = database;
        this.schema = schema;
        this.parent_schema = parentSchema;
        this.parent_name = parentName;
        this.comment = comment;
        this.data_type = dataType;
        this.signature = signature;
        this.routine_id = routineId;
    }

    public String getName() { return name; }
    public CompletionAssistantCandidateKind getKind() { return kind; }
    public String getDatabase() { return database; }
    public String getSchema() { return schema; }
    public String getParent_schema() { return parent_schema; }
    public String getParent_name() { return parent_name; }
    public String getComment() { return comment; }
    public String getData_type() { return data_type; }
    public String getSignature() { return signature; }
    public String getRoutine_id() { return routine_id; }
}
