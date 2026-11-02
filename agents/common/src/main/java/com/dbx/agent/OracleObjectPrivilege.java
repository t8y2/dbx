package com.dbx.agent;

/**
 * Oracle-compatible object privilege row used when reconstructing GRANT DDL.
 */
public final class OracleObjectPrivilege {
    private final String grantee;
    private final String privilege;
    private final boolean grantable;
    private final String columnName;

    public OracleObjectPrivilege(String grantee, String privilege, boolean grantable) {
        this(grantee, privilege, grantable, null);
    }

    public OracleObjectPrivilege(String grantee, String privilege, boolean grantable, String columnName) {
        this.grantee = grantee;
        this.privilege = privilege;
        this.grantable = grantable;
        this.columnName = columnName;
    }

    public String grantee() {
        return grantee;
    }

    public String privilege() {
        return privilege;
    }

    public boolean grantable() {
        return grantable;
    }

    public String columnName() {
        return columnName;
    }
}
