package com.dbx.agent;

/** Shared wire shape for partition and subpartition metadata. */
public record PartitionInfo(String name, int position, String value, String partition_type, String partition_key) {
}
