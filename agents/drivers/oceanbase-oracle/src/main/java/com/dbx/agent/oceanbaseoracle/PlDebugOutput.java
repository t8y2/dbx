package com.dbx.agent.oceanbaseoracle;

import java.io.Reader;
import java.sql.CallableStatement;
import java.sql.Clob;
import java.sql.SQLException;
import java.sql.Types;
import java.util.List;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.UUID;
import java.util.function.Function;

/** Debuggee-side capture and replayable Agent-side pages; adapted from the author debugger. */
final class PlDebugOutput {
    static final int MAX_CHARS = 16 * 1024 * 1024;
    static final int MAX_PAGE_CHARS = 64 * 1024;

    record Block(String sql, int sourceLineOffset, int sourceLineCount, Set<String> privateNames, int callLine,
                 String rootTokenName, String rootToken, String source) {
        List<PlDebugNative.Value> userValues(List<PlDebugNative.Value> values) {
            return values.stream().filter(value -> !privateNames.contains(value.name())).toList();
        }
        String executionPhaseName() {
            if(rootTokenName==null||!rootTokenName.endsWith("ROOT_TOKEN"))return null;
            String phase=rootTokenName.substring(0,rootTokenName.length()-"ROOT_TOKEN".length())+"PHASE";
            return privateNames.contains(phase)?phase:null;
        }
    }
    record Text(String text, boolean complete, boolean truncated, String error) {}
    record Capture(int errorCode, String error, int savepointRollback, Text output) {}
    record Body(String declarations, String sql, String footer, int callLine,
                Set<String> privateNames, String rollbackCondition) {}
    record Page(String text, int offset, int nextOffset, int totalChars,
                boolean complete, boolean truncated, String error) {}

    private static final String DECLARATIONS = """
        DECLARE
          dbx_pd_output CLOB;
          dbx_pd_line VARCHAR2(32767);
          dbx_pd_status INTEGER;
          dbx_pd_error INTEGER := 0;
          dbx_pd_message VARCHAR2(32767);
          dbx_pd_rollback INTEGER := -1;
          dbx_pd_output_error VARCHAR2(32767);
        BEGIN
        """;

    private static final String CAPTURE_TAIL = """
          BEGIN
            SYS.DBMS_DEBUG.DEBUG_OFF;
            SYS.DBMS_LOB.CREATETEMPORARY(dbx_pd_output, TRUE);
            LOOP
              SYS.DBMS_OUTPUT.GET_LINE(dbx_pd_line, dbx_pd_status);
              EXIT WHEN dbx_pd_status <> 0;
              IF dbx_pd_line IS NOT NULL THEN
                SYS.DBMS_LOB.WRITEAPPEND(dbx_pd_output, LENGTH(dbx_pd_line), dbx_pd_line);
              END IF;
              SYS.DBMS_LOB.WRITEAPPEND(dbx_pd_output, 1, CHR(10));
            END LOOP;
          EXCEPTION WHEN OTHERS THEN dbx_pd_output_error := SQLERRM;
          END;
          ? := dbx_pd_error;
          ? := dbx_pd_message;
          ? := dbx_pd_rollback;
          ? := dbx_pd_output;
          ? := dbx_pd_output_error;
        END;
        """;

    static Block wrap(String target) {
        return wrap(target, ignored -> new Body("", target, "", 0, Set.of(), "TRUE"));
    }

    static Block wrap(String collisionSource, Function<String, Body> render) {
        String token;
        String privatePrefix;
        String savepoint;
        String userSource = collisionSource.toUpperCase(Locale.ROOT);
        do {
            token = UUID.randomUUID().toString().replace("-", "").substring(0, 12).toUpperCase(Locale.ROOT);
            privatePrefix = "DBX_" + token + "_";
            savepoint = "DBX_PD_" + token;
        } while (userSource.contains(privatePrefix) || userSource.contains(savepoint));
        Body body = render.apply(privatePrefix);
        String declarations = DECLARATIONS.replace("dbx_pd_", privatePrefix)
            .replace("BEGIN\n", body.declarations() + "BEGIN\n");
        String rootTokenName = privatePrefix + "ROOT_TOKEN";
        declarations = declarations.replaceFirst("DECLARE\\n",
            "DECLARE\n  " + rootTokenName + " CONSTANT VARCHAR2(32) := '" + token + "';\n");
        String prefix = declarations + "  SAVEPOINT " + savepoint + ";\n  BEGIN\n";
        String failure = "\n  EXCEPTION WHEN OTHERS THEN\n"
            + "    dbx_pd_error := SQLCODE; dbx_pd_message := SQLERRM;\n"
            + "    IF " + body.rollbackCondition() + " THEN\n"
            + "      BEGIN ROLLBACK TO " + savepoint + "; dbx_pd_rollback := 1;\n"
            + "      EXCEPTION WHEN OTHERS THEN dbx_pd_rollback := 0; END;\n    END IF;\n  END;\n";
        String namesPrefix = privatePrefix;
        Set<String> privateNames = new HashSet<>(List.of("OUTPUT", "LINE", "STATUS", "ERROR", "MESSAGE", "ROLLBACK", "OUTPUT_ERROR")
            .stream().map(suffix -> namesPrefix + suffix).collect(Collectors.toUnmodifiableSet()));
        privateNames.addAll(body.privateNames());
        privateNames.add(rootTokenName);
        // Replace only generated text, never identifiers or literals in user source.
        int offset = (int) prefix.chars().filter(c -> c == '\n').count();
        return new Block(prefix + body.sql() + failure.replace("dbx_pd_", privatePrefix) + body.footer()
            + CAPTURE_TAIL.replace("dbx_pd_", privatePrefix), offset, body.sql().split("\n", -1).length,
            Set.copyOf(privateNames), body.callLine() == 0 ? 0 : offset + body.callLine(), rootTokenName,
            token, body.sql());
    }

    /** Contains no user source or routine call; only run after the original statement returned. */
    static String cleanupSql() {
        return DECLARATIONS + CAPTURE_TAIL;
    }

    static void register(CallableStatement call, int first) throws SQLException {
        call.registerOutParameter(first, Types.INTEGER);
        call.registerOutParameter(first + 1, Types.VARCHAR);
        call.registerOutParameter(first + 2, Types.INTEGER);
        call.registerOutParameter(first + 3, Types.CLOB);
        call.registerOutParameter(first + 4, Types.VARCHAR);
    }

    static Capture read(CallableStatement call, int first) throws SQLException {
        int error = call.getInt(first);
        if (call.wasNull()) throw new SQLException("No debuggee execution outcome was returned");
        String message = call.getString(first + 1);
        int rollback = call.getInt(first + 2);
        String outputError = call.getString(first + 4);
        Text output = readText(call.getClob(first + 3), outputError, MAX_CHARS);
        return new Capture(error, message, rollback, output);
    }

    static Text readText(Clob clob, String nativeError, int limit) {
        if (clob == null) return new Text("", false, false,
            nativeError == null ? "No DBMS_OUTPUT capture was returned" : nativeError);
        StringBuilder text = new StringBuilder();
        boolean truncated = false;
        String error = nativeError;
        try (Reader reader = clob.getCharacterStream()) {
            char[] buffer = new char[4096];
            int count;
            while ((count = reader.read(buffer)) != -1) {
                int retained = Math.min(count, Math.max(0, limit - text.length()));
                text.append(buffer, 0, retained);
                truncated |= retained < count;
            }
        } catch (Exception failure) {
            error = error == null ? "DBMS_OUTPUT transfer failed" : error + "; DBMS_OUTPUT transfer failed";
        } finally {
            try { clob.free(); }
            catch (SQLException failure) {
                error = error == null ? "DBMS_OUTPUT locator release failed" : error + "; locator release failed";
            }
        }
        if (truncated && !text.isEmpty() && Character.isHighSurrogate(text.charAt(text.length() - 1))) {
            text.setLength(text.length() - 1);
        }
        return new Text(text.toString(), error == null && !truncated, truncated, error);
    }

    static Page page(Text output, int offset, int limit) {
        String text = output.text();
        if (offset < 0 || offset > text.length()) throw new IllegalArgumentException("Invalid output cursor");
        if (offset > 0 && offset < text.length() && Character.isLowSurrogate(text.charAt(offset))
            && Character.isHighSurrogate(text.charAt(offset - 1))) {
            throw new IllegalArgumentException("Output cursor splits a Unicode character");
        }
        if (limit < 2 || limit > MAX_PAGE_CHARS) throw new IllegalArgumentException("Invalid output page size");
        int end = offset + Math.min(limit, text.length() - offset);
        if (end < text.length() && end > offset && Character.isHighSurrogate(text.charAt(end - 1))
            && Character.isLowSurrogate(text.charAt(end))) end--;
        return new Page(text.substring(offset, end), offset, end, text.length(), output.complete(),
            output.truncated(), output.error());
    }

    private PlDebugOutput() {}
}
