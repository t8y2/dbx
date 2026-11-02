package com.dbx.agent;

import java.util.Collections;
import java.util.List;
import java.util.Map;

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
 * <p>{@code schema} is the owner used to qualify the target; when null or empty the
 * session's current schema is used. {@code params} lists routine parameters
 * (IN/IN OUT values are bound; OUT values are returned in the result).
 */
public class PlDebugStartRequest {
    private String operationId;
    private String schema;
    private String objectType;
    private String objectName;
    private String packageName;
    private String source;
    private List<PlDebugParam> params;
    private Map<String, Object> targetSignature;
    private String metadataPreparation;

    /** Immutable start identity, also used to recover an in-flight Agent start. */
    public String getOperationId() {
        return operationId;
    }

    public void setOperationId(String operationId) {
        this.operationId = operationId;
    }

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

    /** Exact metadata snapshot selected from pl_debug_resolve_target. */
    public Map<String, Object> getTargetSignature() {
        return targetSignature;
    }

    public void setTargetSignature(Map<String, Object> targetSignature) {
        this.targetSignature = targetSignature;
    }

    public String getMetadataPreparation() {
        return metadataPreparation;
    }

    public void setMetadataPreparation(String metadataPreparation) {
        this.metadataPreparation = metadataPreparation;
    }
}
