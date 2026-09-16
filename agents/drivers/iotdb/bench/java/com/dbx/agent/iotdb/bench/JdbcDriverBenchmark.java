package com.dbx.agent.iotdb.bench;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

public final class JdbcDriverBenchmark {
    private static final String CLIENT_VERSION = "2.0.8";
    private static final String DATABASE = "root.dbx_bench";
    private static final String DEVICE = DATABASE + ".d1";

    private JdbcDriverBenchmark() {
    }

    public static void main(String[] args) throws Exception {
        Class.forName("org.apache.iotdb.jdbc.IoTDBDriver");
        Config config = Config.fromEnvironment();
        switch (config.mode()) {
            case "prepare" -> prepare(config);
            case "probe" -> probe(config);
            case "hold" -> hold(config);
            case "benchmark" -> benchmark(config);
            default -> throw new IllegalArgumentException("Unsupported IOTDB_BENCH_MODE: " + config.mode());
        }
    }

    private static void prepare(Config config) throws SQLException {
        try (Connection connection = openConnection(config);
             Statement statement = connection.createStatement()) {
            try {
                statement.execute("DROP DATABASE " + DATABASE);
            } catch (SQLException ignored) {
            }
            statement.execute("CREATE DATABASE " + DATABASE);
            statement.execute("CREATE TIMESERIES " + DEVICE + ".s1 WITH DATATYPE=INT64, ENCODING=RLE");
            statement.execute("CREATE TIMESERIES " + DEVICE + ".s2 WITH DATATYPE=DOUBLE, ENCODING=GORILLA");
            statement.execute("CREATE TIMESERIES " + DEVICE + ".s3 WITH DATATYPE=TEXT, ENCODING=PLAIN");

            String insertSql = "INSERT INTO " + DEVICE + "(time,s1,s2,s3) VALUES(?,?,?,?)";
            try (PreparedStatement prepared = connection.prepareStatement(insertSql)) {
                for (int row = 1; row <= config.rows(); row++) {
                    prepared.setLong(1, row);
                    prepared.setLong(2, row * 10L);
                    prepared.setDouble(3, row / 10.0);
                    prepared.setString(4, "row-" + row);
                    prepared.addBatch();
                    if (row % config.insertBatchSize() == 0) {
                        prepared.executeBatch();
                    }
                }
                if (config.rows() % config.insertBatchSize() != 0) {
                    prepared.executeBatch();
                }
            }
        }
        System.out.printf(Locale.ROOT, "{\"prepared_rows\":%d,\"database\":\"%s\"}%n", config.rows(), DATABASE);
    }

    private static void probe(Config config) throws SQLException {
        long started = System.nanoTime();
        try (Connection connection = openConnection(config)) {
            double connectMs = elapsedMillis(started);
            QueryObservation observation = executeQuery(connection, config.fetchSize(), "SHOW DATABASES");
            System.out.printf(
                Locale.ROOT,
                "{\"driver\":\"jdbc\",\"client_version\":\"%s\",\"connect_ms\":%.3f,\"rows\":%d}%n",
                CLIENT_VERSION,
                connectMs,
                observation.rows()
            );
        }
    }

    private static void hold(Config config) throws Exception {
        try (Connection connection = openConnection(config)) {
            QueryObservation observation = executeQuery(connection, config.fetchSize(), "SHOW DATABASES");
            System.out.printf(
                Locale.ROOT,
                "{\"driver\":\"jdbc\",\"client_version\":\"%s\",\"ready\":true,\"rows\":%d}%n",
                CLIENT_VERSION,
                observation.rows()
            );
            System.out.flush();
            Thread.sleep(envInt("BENCH_HOLD_MS", 30_000));
        }
    }

    private static void benchmark(Config config) throws SQLException {
        long connectStarted = System.nanoTime();
        try (Connection connection = openConnection(config)) {
            double connectMs = elapsedMillis(connectStarted);
            List<Workload> workloads = List.of(
                new Workload("show_databases", "SHOW DATABASES", config.metadataIterations()),
                new Workload(
                    "point_query",
                    "SELECT s1,s2,s3 FROM " + DEVICE + " WHERE time = " + Math.max(1, config.rows() / 2),
                    config.pointIterations()
                ),
                new Workload("range_100", "SELECT s1,s2,s3 FROM " + DEVICE + " LIMIT 100", config.rangeIterations()),
                new Workload("scan_all", "SELECT s1,s2,s3 FROM " + DEVICE, config.scanIterations())
            );

            List<WorkloadResult> results = new ArrayList<>();
            for (Workload workload : workloads) {
                int warmups = workload.name().equals("scan_all") ? Math.min(1, config.warmups()) : config.warmups();
                for (int index = 0; index < warmups; index++) {
                    executeQuery(connection, config.fetchSize(), workload.sql());
                }
                results.add(runWorkload(connection, config.fetchSize(), workload));
            }

            System.out.println(resultJson(config, connectMs, results));
        }
    }

    private static WorkloadResult runWorkload(Connection connection, int fetchSize, Workload workload) throws SQLException {
        List<Double> samples = new ArrayList<>(workload.iterations());
        long expectedRows = -1;
        long expectedCells = -1;
        for (int index = 0; index < workload.iterations(); index++) {
            long started = System.nanoTime();
            QueryObservation observation = executeQuery(connection, fetchSize, workload.sql());
            samples.add(elapsedMillis(started));
            if (expectedRows < 0) {
                expectedRows = observation.rows();
                expectedCells = observation.decodedCells();
            } else if (expectedRows != observation.rows() || expectedCells != observation.decodedCells()) {
                throw new IllegalStateException("Unstable result shape for " + workload.name());
            }
        }
        return WorkloadResult.from(workload.name(), samples, expectedRows, expectedCells);
    }

    private static QueryObservation executeQuery(Connection connection, int fetchSize, String sql) throws SQLException {
        long rows = 0;
        long decodedCells = 0;
        try (Statement statement = connection.createStatement()) {
            statement.setFetchSize(fetchSize);
            try (ResultSet resultSet = statement.executeQuery(sql)) {
                ResultSetMetaData metadata = resultSet.getMetaData();
                int columns = metadata.getColumnCount();
                while (resultSet.next()) {
                    rows++;
                    for (int column = 1; column <= columns; column++) {
                        resultSet.getObject(column);
                        decodedCells++;
                    }
                }
            }
        }
        return new QueryObservation(rows, decodedCells);
    }

    private static Connection openConnection(Config config) throws SQLException {
        String url = "jdbc:iotdb://" + config.host() + ":" + config.port() + "/";
        return DriverManager.getConnection(url, config.username(), config.password());
    }

    private static String resultJson(Config config, double connectMs, List<WorkloadResult> results) {
        StringBuilder json = new StringBuilder(512);
        json.append('{')
            .append("\"driver\":\"jdbc\",")
            .append("\"client_version\":\"").append(CLIENT_VERSION).append("\",")
            .append("\"connect_ms\":").append(decimal(connectMs)).append(',')
            .append("\"fetch_size\":").append(config.fetchSize()).append(',')
            .append("\"workloads\":[");
        for (int index = 0; index < results.size(); index++) {
            if (index > 0) {
                json.append(',');
            }
            json.append(results.get(index).toJson());
        }
        return json.append("]}").toString();
    }

    private static double elapsedMillis(long started) {
        return (System.nanoTime() - started) / 1_000_000.0;
    }

    private static String decimal(double value) {
        return String.format(Locale.ROOT, "%.3f", value);
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static int envInt(String name, int fallback) {
        return Integer.parseInt(env(name, Integer.toString(fallback)));
    }

    private record Config(
        String mode,
        String host,
        int port,
        String username,
        String password,
        int rows,
        int fetchSize,
        int insertBatchSize,
        int warmups,
        int metadataIterations,
        int pointIterations,
        int rangeIterations,
        int scanIterations
    ) {
        private static Config fromEnvironment() {
            return new Config(
                env("IOTDB_BENCH_MODE", "benchmark"),
                env("IOTDB_HOST", "127.0.0.1"),
                envInt("IOTDB_PORT", 6667),
                env("IOTDB_USERNAME", "root"),
                env("IOTDB_PASSWORD", "root"),
                envInt("BENCH_ROWS", 10_000),
                envInt("BENCH_FETCH_SIZE", 1_024),
                envInt("BENCH_INSERT_BATCH_SIZE", 500),
                envInt("BENCH_WARMUPS", 3),
                envInt("BENCH_METADATA_ITERATIONS", 20),
                envInt("BENCH_POINT_ITERATIONS", 100),
                envInt("BENCH_RANGE_ITERATIONS", 30),
                envInt("BENCH_SCAN_ITERATIONS", 5)
            );
        }
    }

    private record Workload(String name, String sql, int iterations) {
    }

    private record QueryObservation(long rows, long decodedCells) {
    }

    private record WorkloadResult(
        String name,
        int iterations,
        long rows,
        long decodedCells,
        double meanMs,
        double p50Ms,
        double p95Ms,
        double minMs,
        double maxMs
    ) {
        private static WorkloadResult from(String name, List<Double> samples, long rows, long decodedCells) {
            List<Double> ordered = new ArrayList<>(samples);
            Collections.sort(ordered);
            double total = samples.stream().mapToDouble(Double::doubleValue).sum();
            return new WorkloadResult(
                name,
                samples.size(),
                rows,
                decodedCells,
                total / samples.size(),
                percentile(ordered, 0.50),
                percentile(ordered, 0.95),
                ordered.get(0),
                ordered.get(ordered.size() - 1)
            );
        }

        private static double percentile(List<Double> values, double fraction) {
            int index = Math.max(0, (int) Math.ceil(values.size() * fraction) - 1);
            return values.get(Math.min(values.size() - 1, index));
        }

        private String toJson() {
            return "{\"name\":\"" + name + "\""
                + ",\"iterations\":" + iterations
                + ",\"rows\":" + rows
                + ",\"decoded_cells\":" + decodedCells
                + ",\"mean_ms\":" + decimal(meanMs)
                + ",\"p50_ms\":" + decimal(p50Ms)
                + ",\"p95_ms\":" + decimal(p95Ms)
                + ",\"min_ms\":" + decimal(minMs)
                + ",\"max_ms\":" + decimal(maxMs)
                + '}';
        }
    }
}
