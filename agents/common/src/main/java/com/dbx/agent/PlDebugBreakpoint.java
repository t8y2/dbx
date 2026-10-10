package com.dbx.agent;

/**
 * A source-level breakpoint on a PL object.
 *
 * <p>{@code kind} distinguishes the three target shapes DBX supports:
 * a named top-level procedure/function ({@code PROCEDURE}, {@code FUNCTION}),
 * a routine inside a package (still {@code PROCEDURE}/{@code FUNCTION}, with
 * {@code packageName} on the start request) and an anonymous block
 * ({@code ANONYMOUS}), whose breakpoint is bound to the running debuggee
 * rather than to a stored object. {@code breakpointNumber} is assigned by
 * {@code DBMS_DEBUG} when the breakpoint is created and is echoed back for
 * later removal.
 */
public class PlDebugBreakpoint {
    private String owner;
    private String name;
    private Integer line;
    private Integer breakpointNumber;
    private String kind;
    /**
     * Optional overload disambiguation attributes, mirrored from
     * {@code DBMS_DEBUG.PROGRAM_INFO}. Both stay {@code null} when the caller did
     * not provide them, which is what makes the server-side overload warning
     * applicable; an empty signature or a negative sequence is a supplied value
     * that simply carries no disambiguation.
     */
    private String signature;
    private Integer sequence;
    /**
     * Non-fatal diagnostic attached to a created breakpoint (an overloaded target
     * armed without signature/sequence, or overload attributes the server cannot
     * store). The breakpoint is still created: a warning never turns into a
     * failure.
     */
    private String warning;

    public PlDebugBreakpoint() {
    }

    public String getOwner() {
        return owner;
    }

    public void setOwner(String owner) {
        this.owner = owner;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Integer getLine() {
        return line;
    }

    public void setLine(Integer line) {
        this.line = line;
    }

    public Integer getBreakpointNumber() {
        return breakpointNumber;
    }

    public void setBreakpointNumber(Integer breakpointNumber) {
        this.breakpointNumber = breakpointNumber;
    }

    public String getKind() {
        return kind;
    }

    public void setKind(String kind) {
        this.kind = kind;
    }

    public String getSignature() {
        return signature;
    }

    public void setSignature(String signature) {
        this.signature = signature;
    }

    public Integer getSequence() {
        return sequence;
    }

    public void setSequence(Integer sequence) {
        this.sequence = sequence;
    }

    public String getWarning() {
        return warning;
    }

    public void setWarning(String warning) {
        this.warning = warning;
    }
}
