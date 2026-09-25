package com.dbx.agent;

import java.util.LinkedHashMap;
import java.util.Map;

/** Request-scoped, monotonic timings. Disabled unless a driver explicitly opens a scope. */
public final class QueryTiming implements AutoCloseable {
    private static final ThreadLocal<QueryTiming> CURRENT = new ThreadLocal<>();
    private final Map<String, Double> stages = new LinkedHashMap<>();
    private final long started = System.nanoTime();
    private final QueryTiming previous;

    private QueryTiming() {
        previous = CURRENT.get();
        CURRENT.set(this);
    }

    public static QueryTiming begin() { return new QueryTiming(); }

    public static void record(String stage, long started) {
        QueryTiming timing = CURRENT.get();
        if (timing != null) timing.stages.merge(stage, (System.nanoTime() - started) / 1_000_000.0, Double::sum);
    }

    public Map<String, Double> finish() {
        Map<String, Double> result = new LinkedHashMap<>(stages);
        result.put("agent_total", (System.nanoTime() - started) / 1_000_000.0);
        return result;
    }

    @Override public void close() {
        // A driver scope also works for direct calls. When invoked through the
        // RPC boundary, carry its non-overlapping stages into the outer request.
        // agent_total is a snapshot only; never merge nested totals.
        if (previous != null) stages.forEach((key, value) -> previous.stages.merge(key, value, Double::sum));
        if (previous == null) CURRENT.remove(); else CURRENT.set(previous);
    }
}
