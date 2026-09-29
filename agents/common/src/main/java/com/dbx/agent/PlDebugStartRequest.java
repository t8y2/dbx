package com.dbx.agent;

import java.util.Collections;
import java.util.List;

/**
 * Request to start a PL/SQL debugging session.
 *
 * <p>The target is one of:
 * <ul>
 *   <li>{@code objectType = "PROCEDURE" | "FUNCTION"}: a stored routine;
 *       {@code packageName} names the owning package when the routine lives
 *       inside one (the package body is what {@code DBMS_DEBUG} resolves).</li>
 *   <li>{@code objectType = "ANONYMOUS"}: {@code source} carries the anonymous
 *       block to execute and debug.</li>
 * </ul>
 *
 * <p>{@code schema} is the owner used to qualify the target; when blank the
 * session's current schema is used. {@code params} lists routine parameters
 * (IN/IN OUT values are bound; OUT values are returned in the result).
 */
public class PlDebugStartRequest {
    private String schema;
    private String objectType;
    private String objectName;
    private String packageName;
    private String source;
    private List<PlDebugParam> params;

    public String getSchema() {
        return schema;
    }

    public void setSchema(String schema) {
        this.schema = schema;
    }

    public String getObjectType() {
        return objectType;
    }

    public void setObjectType(String objectType) {
        this.objectType = objectType;
    }

    public String getObjectName() {
        return objectName;
    }

    public void setObjectName(String objectName) {
        this.objectName = objectName;
    }

    public String getPackageName() {
        return packageName;
    }

    public void setPackageName(String packageName) {
        this.packageName = packageName;
    }

    public String getSource() {
        return source;
    }

    public void setSource(String source) {
        this.source = source;
    }

    public List<PlDebugParam> getParams() {
        return params == null ? Collections.emptyList() : params;
    }

    public void setParams(List<PlDebugParam> params) {
        this.params = params;
    }
}
