package com.dbx.agent.oceanbaseoracle;

import java.util.ArrayList;
import java.util.List;

/**
 * DDL for the per-schema helper package the debugger creates before the first
 * session, plus the routine names it calls afterwards.
 *
 * <p>The package is a thin wrapper over the server-side {@code DBMS_DEBUG}
 * primitives: the client driver cannot call procedures with OUT parameters
 * through plain statements, so every primitive that returns values is wrapped
 * here. The definitions are adapted from OceanBase Developer Center
 * (https://github.com/oceanbase/odc, Apache-2.0) with an independent package
 * name ({@code DBX_PL_DEBUG_PACKAGE}) so DBX and ODC can coexist on the same
 * schema without overwriting each other's helper objects.
 *
 * <p>Routine naming follows the same {@code DBX_} prefix for the same reason.
 */
final class DbxPlDebugPackage {
    static final String PACKAGE_NAME = "DBX_PL_DEBUG_PACKAGE";
    private static final String VERSION_NOTE = "-- DBX PL Debug Package Version: V1";

    static final String PROCEDURE_SET_BREAKPOINT = "DBX_SET_BREAKPOINT";
    static final String PROCEDURE_SET_BREAKPOINT_ANONYMOUS = "DBX_SET_BREAKPOINT_ANONYMOUS";
    static final String PROCEDURE_SHOW_BREAKPOINTS = "DBX_SHOW_BREAKPOINTS";
    static final String PROCEDURE_PRINT_BACKTRACE = "DBX_PRINT_BACKTRACE";
    static final String PROCEDURE_CNT_NEXT_LINE = "DBX_CNT_NEXT_LINE";
    static final String PROCEDURE_CNT_NEXT_BREAKPOINT = "DBX_CNT_NEXT_BREAKPOINT";
    static final String PROCEDURE_CNT_STEP_IN = "DBX_CNT_STEP_IN";
    static final String PROCEDURE_CNT_ABORT = "DBX_CNT_ABORT";
    static final String PROCEDURE_CNT_STEP_OUT = "DBX_CNT_STEP_OUT";
    static final String PROCEDURE_GET_VALUES = "DBX_GET_VALUES";
    static final String PROCEDURE_GET_VALUE = "DBX_GET_VALUE";
    static final String PROCEDURE_GET_RUNTIME_INFO = "DBX_GET_RUNTIME_INFO";
    static final String PROCEDURE_SYNCHRONIZE = "DBX_SYNCHRONIZE";
    static final String PROCEDURE_GET_LINE = "DBX_GET_LINE";

    private static final String RUN_INFO_MESSAGE =
        "message := ' breakpoint = ' || run_info.breakpoint"
            + " || ', stackdepth = ' || run_info.stackdepth"
            + " || ', reason = ' || run_info.reason"
            + " || ', line = ' || run_info.\"line#\""
            + " || ', programname = ' || run_info.program.name"
            + " || ', programowner = ' || run_info.program.owner;";

    private static final String SET_BREAKPOINT =
        "PROCEDURE " + PROCEDURE_SET_BREAKPOINT
            + "(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " pro_info dbms_debug.program_info;"
            + " BEGIN"
            + " pro_info.name := name;"
            + " pro_info.owner := owner;"
            + " result := dbms_debug.set_breakpoint(pro_info, line#, breakpoint#);"
            + "END;";

    private static final String SET_BREAKPOINT_ANONYMOUS =
        "PROCEDURE " + PROCEDURE_SET_BREAKPOINT_ANONYMOUS
            + "(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " run_info dbms_debug.runtime_info;"
            + " BEGIN"
            + " result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info);"
            + " result := dbms_debug.set_breakpoint(run_info.program, line#, breakpoint#);"
            + "END;";

    private static final String SHOW_BREAKPOINTS =
        "PROCEDURE " + PROCEDURE_SHOW_BREAKPOINTS + "(listing in out varchar2) IS "
            + "BEGIN"
            + " dbms_debug.show_breakpoints(listing);"
            + "END;";

    private static final String PRINT_BACKTRACE =
        "PROCEDURE " + PROCEDURE_PRINT_BACKTRACE
            + "(listing IN OUT VARCHAR, status OUT BINARY_INTEGER) IS "
            + " run_info dbms_debug.runtime_info;"
            + " result BINARY_INTEGER;"
            + "BEGIN "
            + " result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info);"
            + " status := run_info.terminated;"
            + " dbms_debug.print_backtrace(listing);"
            + "END;";

    private static final String CNT_NEXT_LINE =
        "PROCEDURE " + PROCEDURE_CNT_NEXT_LINE + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_next_line);"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String CNT_NEXT_BREAKPOINT =
        "PROCEDURE " + PROCEDURE_CNT_NEXT_BREAKPOINT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_any_return);"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String CNT_STEP_IN =
        "PROCEDURE " + PROCEDURE_CNT_STEP_IN + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_any_call);"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String CNT_ABORT =
        "PROCEDURE " + PROCEDURE_CNT_ABORT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.abort_execution);"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String CNT_STEP_OUT =
        "PROCEDURE " + PROCEDURE_CNT_STEP_OUT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + "  run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.continue(run_info, dbms_debug.break_any_return);"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String GET_VALUES =
        "PROCEDURE " + PROCEDURE_GET_VALUES
            + "(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER) IS"
            + " BEGIN"
            + "  result := dbms_debug.get_values(scalar_values);"
            + "END;";

    private static final String GET_VALUE =
        "PROCEDURE " + PROCEDURE_GET_VALUE
            + "(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER) IS"
            + " BEGIN"
            + "  result := dbms_debug.get_value(variable_name, frame#, value);"
            + "END;";

    private static final String GET_RUNTIME_INFO =
        "PROCEDURE " + PROCEDURE_GET_RUNTIME_INFO
            + "(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER) IS"
            + " run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + " result := dbms_debug.get_runtime_info(dbms_debug.info_getLineinfo, run_info);"
            + " status := run_info.terminated;"
            + "END;";

    private static final String SYNCHRONIZE =
        "PROCEDURE " + PROCEDURE_SYNCHRONIZE
            + "(result OUT BINARY_INTEGER, message OUT VARCHAR2) IS"
            + " run_info dbms_debug.runtime_info;"
            + "BEGIN"
            + "  result := dbms_debug.synchronize(run_info, dbms_debug.info_getLineinfo);"
            + "  " + RUN_INFO_MESSAGE
            + "END;";

    private static final String GET_LINE =
        "PROCEDURE " + PROCEDURE_GET_LINE + "(line OUT VARCHAR2, status OUT INTEGER) IS "
            + "  log VARCHAR2(10000) := '';"
            + "  fetched VARCHAR2(10000);"
            + "BEGIN"
            + "  <<label>>"
            + "  loop"
            + "    dbms_output.get_line(fetched, status);"
            + "    if status = 1 then"
            + "      exit label;"
            + "    else "
            + "      log := log || '\n' || fetched;"
            + "    end if;"
            + "   end loop label;"
            + " line := log;"
            + "END;";

    private static final String WRAPPED_PACKAGE_HEAD = "CREATE OR REPLACE PACKAGE "
        + "%s" + PACKAGE_NAME + " AS"
        + " PROCEDURE " + PROCEDURE_SET_BREAKPOINT
        + "(owner IN VARCHAR2, name IN VARCHAR2, line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SET_BREAKPOINT_ANONYMOUS
        + "(line# IN BINARY_INTEGER, breakpoint# OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SHOW_BREAKPOINTS + "(listing in out varchar2);"
        + " PROCEDURE " + PROCEDURE_PRINT_BACKTRACE
        + "(listing IN OUT VARCHAR, status OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_CNT_NEXT_LINE
        + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_NEXT_BREAKPOINT
        + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_STEP_IN + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_ABORT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_CNT_STEP_OUT + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_GET_VALUES
        + "(scalar_values OUT VARCHAR2, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_GET_VALUE
        + "(variable_name VARCHAR2, frame# BINARY_INTEGER, value OUT VARCHAR2, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_GET_RUNTIME_INFO
        + "(status OUT BINARY_INTEGER, result OUT BINARY_INTEGER);"
        + " PROCEDURE " + PROCEDURE_SYNCHRONIZE + "(result OUT BINARY_INTEGER, message OUT VARCHAR2);"
        + " PROCEDURE " + PROCEDURE_GET_LINE
        + "(line OUT VARCHAR2, status OUT INTEGER);"
        + "END " + PACKAGE_NAME + ";";

    private static final String WRAPPED_PACKAGE_BODY = "CREATE OR REPLACE PACKAGE BODY "
        + "%s" + PACKAGE_NAME + " AS "
        + VERSION_NOTE + "\n"
        + SET_BREAKPOINT
        + SET_BREAKPOINT_ANONYMOUS
        + SHOW_BREAKPOINTS
        + PRINT_BACKTRACE
        + CNT_NEXT_LINE
        + CNT_NEXT_BREAKPOINT
        + CNT_STEP_IN
        + CNT_ABORT
        + CNT_STEP_OUT
        + GET_VALUES
        + GET_VALUE
        + GET_RUNTIME_INFO
        + SYNCHRONIZE
        + GET_LINE
        + "END " + PACKAGE_NAME + ";";

    private DbxPlDebugPackage() {
    }

    /**
     * Create statements for the helper package, qualified with the owner when
     * one is given. Qualified DDL keeps package creation independent of the
     * session's current schema.
     */
    static List<String> createStatements(String owner) {
        String prefix = "";
        if (owner != null && !owner.trim().isEmpty()) {
            prefix = "\"" + owner.trim().replace("\"", "\"\"") + "\".";
        }
        List<String> statements = new ArrayList<>(2);
        statements.add(String.format(WRAPPED_PACKAGE_HEAD, prefix));
        statements.add(String.format(WRAPPED_PACKAGE_BODY, prefix));
        return statements;
    }
}
