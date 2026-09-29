package com.dbx.agent;

/**
 * One parameter of a PL object being debugged.
 *
 * <p>{@code mode} is an Oracle parameter mode in upper case ({@code IN},
 * {@code OUT}, {@code IN OUT}); the first debugger version binds IN and
 * IN OUT values and reports OUT values back through the debug result.
 */
public class PlDebugParam {
    private String name;
    private String mode;
    private String type;
    private String value;

    public PlDebugParam() {
    }

    public PlDebugParam(String name, String mode, String type, String value) {
        this.name = name;
        this.mode = mode;
        this.type = type;
        this.value = value;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getMode() {
        return mode;
    }

    public void setMode(String mode) {
        this.mode = mode;
    }

    public String getType() {
        return type;
    }

    public void setType(String type) {
        this.type = type;
    }

    public String getValue() {
        return value;
    }

    public void setValue(String value) {
        this.value = value;
    }
}
