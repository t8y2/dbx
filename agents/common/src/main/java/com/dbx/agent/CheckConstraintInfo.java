package com.dbx.agent;

public final class CheckConstraintInfo {
    private final String name;
    private final String definition;

    public CheckConstraintInfo(String name, String definition) {
        this.name = name;
        this.definition = definition;
    }

    public String getName() {
        return name;
    }

    public String getDefinition() {
        return definition;
    }
}
