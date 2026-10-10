package com.dbx.agent;

import java.util.List;

/** Shared wire shape; null state properties mean the database did not report them. */
public record ConstraintInfo(
    String name, String constraint_type, String definition, List<String> columns,
    Boolean deferrable, Boolean initially_deferred, Boolean enabled, Boolean valid
) {
}
