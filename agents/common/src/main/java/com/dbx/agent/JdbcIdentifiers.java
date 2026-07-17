package com.dbx.agent;

public final class JdbcIdentifiers {
    public static final JdbcIdentifiers INSTANCE = new JdbcIdentifiers();

    private JdbcIdentifiers() {
    }

    public String doubleQuote(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    public String backtick(String identifier) {
        return "`" + identifier.replace("`", "``") + "`";
    }
}
