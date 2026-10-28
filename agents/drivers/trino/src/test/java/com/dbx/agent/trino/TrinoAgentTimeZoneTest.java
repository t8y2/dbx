package com.dbx.agent.trino;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.ZoneId;
import java.util.TimeZone;
import org.junit.jupiter.api.Test;

/**
 * #13451: Trino derives the session zone from the JVM default, but servers built on
 * Joda-Time reject the custom "GMT+08:00" IDs the JVM reports when the OS zone has no
 * IANA mapping. The agent must rewrite such defaults to an equivalent IANA zone
 * before the first connection.
 */
class TrinoAgentTimeZoneTest {
    @Test
    void rewritesCustomGmtOffsetDefaultToEquivalentIanaZone() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("GMT+08:00"));
            long before = TimeZone.getDefault().getOffset(System.currentTimeMillis());

            TrinoAgent.normalizeDefaultTimeZone();

            assertEquals("Etc/GMT-8", TimeZone.getDefault().getID());
            assertEquals(before, TimeZone.getDefault().getOffset(System.currentTimeMillis()));
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test
    void keepsIanaDefaultZonesUntouched() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("Asia/Shanghai"));
            TrinoAgent.normalizeDefaultTimeZone();
            assertEquals("Asia/Shanghai", TimeZone.getDefault().toZoneId().getId());

            TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
            TrinoAgent.normalizeDefaultTimeZone();
            assertEquals("UTC", TimeZone.getDefault().toZoneId().getId());
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test
    void keepsFractionalGmtOffsetsUntouched() {
        TimeZone original = TimeZone.getDefault();
        try {
            // Etc zones only cover whole hours; leave fractional offsets to the JVM.
            TimeZone.setDefault(TimeZone.getTimeZone("GMT+05:30"));
            TrinoAgent.normalizeDefaultTimeZone();
            assertEquals("GMT+05:30", TimeZone.getDefault().toZoneId().getId());
        } finally {
            TimeZone.setDefault(original);
        }
    }

    @Test
    void rewritesNegativeCustomGmtOffsets() {
        TimeZone original = TimeZone.getDefault();
        try {
            TimeZone.setDefault(TimeZone.getTimeZone("GMT-05:00"));
            long before = TimeZone.getDefault().getOffset(System.currentTimeMillis());

            TrinoAgent.normalizeDefaultTimeZone();

            assertEquals("Etc/GMT+5", TimeZone.getDefault().getID());
            assertEquals(before, TimeZone.getDefault().getOffset(System.currentTimeMillis()));
            assertEquals(ZoneId.of("Etc/GMT+5").getRules().getOffset(java.time.Instant.now()).getTotalSeconds() * 1000L, before);
        } finally {
            TimeZone.setDefault(original);
        }
    }
}
