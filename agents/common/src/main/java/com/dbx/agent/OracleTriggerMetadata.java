package com.dbx.agent;

import java.util.List;
import java.util.Map;

/** Raw dictionary identity. Missing fields remain unknown, not false or empty. */
public record OracleTriggerMetadata(
    int contractVersion, String identityMode, String engine, String engineVersion,
    String owner, String name, String scope, String scopeType, String scopeOwner,
    Parent parent, String objectId, String lastDdlTime, Definition definition,
    List<CompilationError> errors, Map<String, ReadState> reads
) {
    public record Parent(String owner, String name, String objectType, String objectId) {}
    public record Definition(String origin, String format, boolean complete) {}
    public record CompilationError(long sequence, long line, long position, String text, String severity) {}
    public record ReadState(String state, String message) {}
}
