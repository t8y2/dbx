package com.dbx.agent;

import com.oceanbase.jdbc.internal.util.exceptions.ExceptionFactory;
import java.sql.SQLException;
import java.sql.SQLTimeoutException;

/** Runs the actual probe classifier without a database or production Agent process. */
public final class HealthProbeOutcomeTest {
    private static int checks;

    public static void main(String[] args) {
        expect("cancelled", new SQLException("not logged", "57014"));
        expect("cancelled", new RuntimeException(new SQLException("not logged", "72000", 1013)));
        expect("cancelled", new SQLTimeoutException("not logged", "57014"));
        expect("timeout", new SQLTimeoutException("not logged"));
        expect("timeout", new RuntimeException(new SQLException("not logged", "HYT00")));
        expect("timeout", new SQLException("not logged", "HYT01"));
        expect("error", new SQLException("cancelled timeout secret SQL", "42000", 1));
        expect("error", new IllegalStateException("cancelled timeout secret SQL"));
        expect("error", new SQLException("not logged", null, 1013));
        expect("error", new SQLException("not logged", "08006", 1013));
        // The real OB factory uses SQLTimeoutException for *every* 70100 error.
        // Both interrupted and timed-out requests can have 1317/70100, so neither
        // the subclass nor a previously delivered JDBC cancel proves the outcome.
        expect("error", ExceptionFactory.INSTANCE.create("not logged", "70100", 1317));
        expect("error", new SQLException("not logged", "70100", 1317));
        System.out.println("HealthProbe outcome checks passed: " + checks);
    }

    private static void expect(String expected, Throwable failure) {
        String actual = HealthProbe.errorOutcome(failure);
        if (!expected.equals(actual)) throw new AssertionError("Expected " + expected + ", got " + actual);
        checks++;
    }
}
