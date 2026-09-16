package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	_ "gitcode.com/opengauss/openGauss-connector-go-pq"
)

type queryResult struct {
	Columns     []string `json:"columns"`
	ColumnTypes []string `json:"column_types"`
	Rows        [][]any  `json:"rows"`
}

type benchmarkResult struct {
	Mode        string  `json:"mode"`
	Concurrency int     `json:"concurrency"`
	Seconds     int     `json:"seconds"`
	Operations  int64   `json:"operations"`
	Errors      int64   `json:"errors"`
	QPS         float64 `json:"qps"`
}

func main() {
	concurrency := envInt("BENCH_CONCURRENCY", 32)
	seconds := envInt("BENCH_SECONDS", 4)
	mode := envOr("BENCH_MODE", "collect")
	db, err := sql.Open("opengauss", dsn())
	if err != nil {
		panic(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(concurrency)
	db.SetMaxIdleConns(concurrency)

	connections := make([]*sql.Conn, concurrency)
	for index := range connections {
		connections[index], err = db.Conn(context.Background())
		if err != nil {
			panic(err)
		}
		defer connections[index].Close()
	}
	for _, connection := range connections {
		for range 2 {
			if err := execute(connection, mode); err != nil {
				panic(err)
			}
		}
	}

	start := time.Now()
	deadline := start.Add(time.Duration(seconds) * time.Second)
	var operations atomic.Int64
	var failures atomic.Int64
	var waitGroup sync.WaitGroup
	for _, connection := range connections {
		waitGroup.Add(1)
		go func(connection *sql.Conn) {
			defer waitGroup.Done()
			for time.Now().Before(deadline) {
				if err := execute(connection, mode); err != nil {
					failures.Add(1)
				} else {
					operations.Add(1)
				}
			}
		}(connection)
	}
	waitGroup.Wait()
	duration := time.Since(start).Seconds()
	result := benchmarkResult{
		Mode:        mode,
		Concurrency: concurrency,
		Seconds:     seconds,
		Operations:  operations.Load(),
		Errors:      failures.Load(),
		QPS:         float64(operations.Load()) / duration,
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		panic(err)
	}
}

func execute(connection *sql.Conn, mode string) error {
	rows, err := connection.QueryContext(context.Background(), querySQL())
	if err != nil {
		return err
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return err
	}
	types, err := rows.ColumnTypes()
	if err != nil {
		return err
	}
	columnTypes := make([]string, len(types))
	for index, columnType := range types {
		columnTypes[index] = columnType.DatabaseTypeName()
	}
	values := make([]any, len(columns))
	destinations := make([]any, len(columns))
	for index := range values {
		destinations[index] = &values[index]
	}
	result := queryResult{Columns: columns, ColumnTypes: columnTypes, Rows: make([][]any, 0, 1000)}
	for rows.Next() {
		if err := rows.Scan(destinations...); err != nil {
			return err
		}
		row := make([]any, len(values))
		for index, value := range values {
			row[index] = normalizeValue(value)
		}
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if mode == "marshal" {
		_, err = json.Marshal(result)
		return err
	}
	return nil
}

func normalizeValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return nil
	case []byte:
		if isTextBytes(typed) {
			return string(typed)
		}
		return map[string]string{"$binary": base64.StdEncoding.EncodeToString(typed)}
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	case int8:
		return int64(typed)
	case int16:
		return int64(typed)
	case int32:
		return int64(typed)
	case float32:
		return float64(typed)
	default:
		return typed
	}
}

func isTextBytes(value []byte) bool {
	for _, char := range value {
		if char == 0 || char < 0x09 || char > 0x0d && char < 0x20 {
			return false
		}
	}
	return true
}

func dsn() string {
	return fmt.Sprintf(
		"host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		envOr("VASTBASE_HOST", "127.0.0.1"),
		envOr("VASTBASE_PORT", "20119"),
		envOr("VASTBASE_USERNAME", "dbx_bench"),
		requiredEnv("DBX_TEST_PASSWORD"),
		envOr("VASTBASE_DATABASE", "dbx_bench"),
	)
}

func querySQL() string {
	return "SELECT value AS id, CAST(value * 1.25 AS numeric(18,2)) AS numeric_value, " +
		"CAST('2024-01-02 03:04:05' AS timestamp) AS timestamp_value, repeat('x', 64) AS text_value " +
		"FROM generate_series(1, 1000) AS value"
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err == nil && value > 0 {
		return value
	}
	return fallback
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func requiredEnv(key string) string {
	value := os.Getenv(key)
	if value == "" {
		panic(key + " is required")
	}
	return value
}
