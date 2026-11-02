package com.dbx.agent.oceanbaseoracle;

import com.dbx.agent.ForeignKeyInfo;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Reads the quoted REF_CONSTRAINT DDL emitted by OceanBase, never executable SQL. */
final class OracleForeignKeyDefinition {
    private final String ddl;
    private int offset;

    private OracleForeignKeyDefinition(String ddl) throws SQLException {
        if (ddl == null || ddl.isBlank()) throw invalid();
        this.ddl = ddl;
    }

    static List<ForeignKeyInfo> read(String ddl, String owner, String table, String name,
                                     String refOwner, String deleteRule) throws SQLException {
        OracleForeignKeyDefinition input = new OracleForeignKeyDefinition(ddl);
        input.word("ALTER"); input.word("TABLE");
        String sourceOwner = input.identifier(); input.symbol('.');
        String sourceTable = input.identifier();
        input.word("ADD"); input.word("CONSTRAINT");
        String constraint = input.identifier();
        input.word("FOREIGN"); input.word("KEY");
        List<String> columns = input.identifiers();
        input.word("REFERENCES");
        String targetOwner = input.identifier(); input.symbol('.');
        String targetTable = input.identifier();
        List<String> references = input.identifiers();
        String action = "NO ACTION";
        if (input.takeWord("ON")) {
            input.word("DELETE");
            if (input.takeWord("CASCADE")) action = "CASCADE";
            else { input.word("SET"); input.word("NULL"); action = "SET NULL"; }
        }
        Set<String> states = new HashSet<>();
        while (!input.finished()) {
            String category;
            if (input.takeWord("ENABLE") || input.takeWord("DISABLE")) category = "enabled";
            else if (input.takeWord("VALIDATE") || input.takeWord("NOVALIDATE")) category = "validated";
            else if (input.takeWord("RELY") || input.takeWord("NORELY")) category = "rely";
            else if (input.takeWord("DEFERRABLE")) category = "deferrable";
            else if (input.takeWord("NOT")) { input.word("DEFERRABLE"); category = "deferrable"; }
            else if (input.takeWord("INITIALLY")) {
                if (!input.takeWord("IMMEDIATE") && !input.takeWord("DEFERRED")) throw invalid();
                category = "initially";
            } else throw invalid();
            if (!states.add(category)) throw invalid();
        }
        if (!owner.equals(sourceOwner) || !table.equals(sourceTable) || !name.equals(constraint)
            || !targetOwner.equals(refOwner) || !action.equals(deleteRule) || columns.size() != references.size()) {
            throw invalid();
        }
        List<ForeignKeyInfo> result = new ArrayList<>();
        for (int i = 0; i < columns.size(); i++) {
            result.add(new ForeignKeyInfo(name, columns.get(i), targetTable, references.get(i), targetOwner, action));
        }
        return result;
    }

    private List<String> identifiers() throws SQLException {
        symbol('(');
        List<String> result = new ArrayList<>();
        result.add(identifier());
        while (takeSymbol(',')) result.add(identifier());
        symbol(')');
        if (new HashSet<>(result).size() != result.size()) throw invalid();
        return result;
    }

    private String identifier() throws SQLException {
        symbol('"');
        StringBuilder value = new StringBuilder();
        while (offset < ddl.length()) {
            char ch = ddl.charAt(offset++);
            if (ch != '"') { value.append(ch); continue; }
            if (offset < ddl.length() && ddl.charAt(offset) == '"') {
                offset++; value.append('"'); continue;
            }
            if (value.isEmpty()) throw invalid();
            return value.toString();
        }
        throw invalid();
    }

    private void whitespace() {
        while (offset < ddl.length() && Character.isWhitespace(ddl.charAt(offset))) offset++;
    }

    private boolean takeSymbol(char symbol) {
        whitespace();
        if (offset >= ddl.length() || ddl.charAt(offset) != symbol) return false;
        offset++;
        return true;
    }

    private void symbol(char symbol) throws SQLException {
        if (!takeSymbol(symbol)) throw invalid();
    }

    private boolean takeWord(String word) {
        whitespace();
        int end = offset + word.length();
        if (!ddl.regionMatches(true, offset, word, 0, word.length())) return false;
        if (end < ddl.length() && (Character.isLetterOrDigit(ddl.charAt(end)) || ddl.charAt(end) == '_')) return false;
        offset = end;
        return true;
    }

    private void word(String word) throws SQLException {
        if (!takeWord(word)) throw invalid();
    }

    private boolean finished() throws SQLException {
        whitespace();
        if (takeSymbol(';')) {
            whitespace();
            if (offset != ddl.length()) throw invalid();
        }
        return offset == ddl.length();
    }

    private static SQLException invalid() {
        return new SQLException("Foreign key definition is incomplete, unsupported, or inconsistent with its metadata", "42000");
    }
}
