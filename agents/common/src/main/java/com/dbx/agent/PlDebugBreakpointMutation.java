package com.dbx.agent;

import java.util.Map;

public record PlDebugBreakpointMutation(String operationId, String sourceRefId, Long sourceRevision,
                                        Long stopRevision, Integer nativeFrameId, Integer line,
                                        Integer breakpointNumber, String registrationId,
                                        Boolean enabled, Map<String, Object> rules) {}
