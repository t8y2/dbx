package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strconv"
	"time"

	"github.com/apache/iotdb-client-go/v2/client"
)

const (
	clientVersion = "2.0.8"
	database      = "root.dbx_bench"
	device        = database + ".d1"
)

type config struct {
	Mode               string
	Host               string
	Port               string
	Username           string
	Password           string
	Rows               int
	FetchSize          int32
	ConnectTimeoutMS   int
	QueryTimeoutMS     int64
	Warmups            int
	MetadataIterations int
	PointIterations    int
	RangeIterations    int
	ScanIterations     int
}

type workload struct {
	Name       string
	SQL        string
	Iterations int
}

type workloadResult struct {
	Name         string  `json:"name"`
	Iterations   int     `json:"iterations"`
	Rows         int64   `json:"rows"`
	DecodedCells int64   `json:"decoded_cells"`
	MeanMS       float64 `json:"mean_ms"`
	P50MS        float64 `json:"p50_ms"`
	P95MS        float64 `json:"p95_ms"`
	MinMS        float64 `json:"min_ms"`
	MaxMS        float64 `json:"max_ms"`
}

type benchmarkResult struct {
	Driver        string           `json:"driver"`
	ClientVersion string           `json:"client_version"`
	ConnectMS     float64          `json:"connect_ms"`
	FetchSize     int32            `json:"fetch_size"`
	Workloads     []workloadResult `json:"workloads"`
}

type queryObservation struct {
	Rows         int64
	DecodedCells int64
}

func main() {
	conf := loadConfig()
	session := client.NewSession(&client.Config{
		Host:      conf.Host,
		Port:      conf.Port,
		UserName:  conf.Username,
		Password:  conf.Password,
		FetchSize: conf.FetchSize,
		TimeZone:  client.DefaultTimeZone,
	})

	connectStarted := time.Now()
	if err := session.Open(false, conf.ConnectTimeoutMS); err != nil {
		fatal(err)
	}
	connectMS := elapsedMS(connectStarted)
	defer session.Close()

	if conf.Mode == "probe" {
		observation, err := executeQuery(&session, conf, "SHOW DATABASES")
		if err != nil {
			fatal(err)
		}
		writeJSON(map[string]any{
			"driver":         "go",
			"client_version": clientVersion,
			"connect_ms":     roundMillis(connectMS),
			"rows":           observation.Rows,
		})
		return
	}
	if conf.Mode == "hold" {
		observation, err := executeQuery(&session, conf, "SHOW DATABASES")
		if err != nil {
			fatal(err)
		}
		writeJSON(map[string]any{
			"driver":         "go",
			"client_version": clientVersion,
			"ready":          true,
			"rows":           observation.Rows,
		})
		time.Sleep(time.Duration(envInt("BENCH_HOLD_MS", 30_000)) * time.Millisecond)
		return
	}
	if conf.Mode != "benchmark" {
		fatal(fmt.Errorf("unsupported IOTDB_BENCH_MODE: %s", conf.Mode))
	}

	workloads := []workload{
		{Name: "show_databases", SQL: "SHOW DATABASES", Iterations: conf.MetadataIterations},
		{
			Name:       "point_query",
			SQL:        fmt.Sprintf("SELECT s1,s2,s3 FROM %s WHERE time = %d", device, max(1, conf.Rows/2)),
			Iterations: conf.PointIterations,
		},
		{Name: "range_100", SQL: "SELECT s1,s2,s3 FROM " + device + " LIMIT 100", Iterations: conf.RangeIterations},
		{Name: "scan_all", SQL: "SELECT s1,s2,s3 FROM " + device, Iterations: conf.ScanIterations},
	}

	results := make([]workloadResult, 0, len(workloads))
	for _, item := range workloads {
		warmups := conf.Warmups
		if item.Name == "scan_all" && warmups > 1 {
			warmups = 1
		}
		for index := 0; index < warmups; index++ {
			if _, err := executeQuery(&session, conf, item.SQL); err != nil {
				fatal(err)
			}
		}
		result, err := runWorkload(&session, conf, item)
		if err != nil {
			fatal(err)
		}
		results = append(results, result)
	}

	writeJSON(benchmarkResult{
		Driver:        "go",
		ClientVersion: clientVersion,
		ConnectMS:     roundMillis(connectMS),
		FetchSize:     conf.FetchSize,
		Workloads:     results,
	})
}

func runWorkload(session *client.Session, conf config, item workload) (workloadResult, error) {
	samples := make([]float64, 0, item.Iterations)
	var expected queryObservation
	for index := 0; index < item.Iterations; index++ {
		started := time.Now()
		observation, err := executeQuery(session, conf, item.SQL)
		if err != nil {
			return workloadResult{}, err
		}
		samples = append(samples, elapsedMS(started))
		if index == 0 {
			expected = observation
		} else if expected != observation {
			return workloadResult{}, fmt.Errorf("unstable result shape for %s", item.Name)
		}
	}

	ordered := append([]float64(nil), samples...)
	sort.Float64s(ordered)
	var total float64
	for _, sample := range samples {
		total += sample
	}
	return workloadResult{
		Name:         item.Name,
		Iterations:   item.Iterations,
		Rows:         expected.Rows,
		DecodedCells: expected.DecodedCells,
		MeanMS:       roundMillis(total / float64(len(samples))),
		P50MS:        roundMillis(percentile(ordered, 0.50)),
		P95MS:        roundMillis(percentile(ordered, 0.95)),
		MinMS:        roundMillis(ordered[0]),
		MaxMS:        roundMillis(ordered[len(ordered)-1]),
	}, nil
}

func executeQuery(session *client.Session, conf config, sql string) (queryObservation, error) {
	timeout := conf.QueryTimeoutMS
	dataset, err := session.ExecuteQueryStatement(sql, &timeout)
	if err != nil {
		return queryObservation{}, err
	}
	defer dataset.Close()

	columns := len(dataset.GetColumnNames())
	var observation queryObservation
	for {
		hasNext, nextErr := dataset.Next()
		if nextErr != nil {
			return queryObservation{}, nextErr
		}
		if !hasNext {
			break
		}
		observation.Rows++
		for column := 1; column <= columns; column++ {
			if _, valueErr := dataset.GetObjectByIndex(int32(column)); valueErr != nil {
				return queryObservation{}, valueErr
			}
			observation.DecodedCells++
		}
	}
	return observation, nil
}

func loadConfig() config {
	return config{
		Mode:               env("IOTDB_BENCH_MODE", "benchmark"),
		Host:               env("IOTDB_HOST", "127.0.0.1"),
		Port:               env("IOTDB_PORT", "6667"),
		Username:           env("IOTDB_USERNAME", "root"),
		Password:           env("IOTDB_PASSWORD", "root"),
		Rows:               envInt("BENCH_ROWS", 10_000),
		FetchSize:          int32(envInt("BENCH_FETCH_SIZE", 1_024)),
		ConnectTimeoutMS:   envInt("BENCH_CONNECT_TIMEOUT_MS", 5_000),
		QueryTimeoutMS:     int64(envInt("BENCH_QUERY_TIMEOUT_MS", 30_000)),
		Warmups:            envInt("BENCH_WARMUPS", 3),
		MetadataIterations: envInt("BENCH_METADATA_ITERATIONS", 20),
		PointIterations:    envInt("BENCH_POINT_ITERATIONS", 100),
		RangeIterations:    envInt("BENCH_RANGE_ITERATIONS", 30),
		ScanIterations:     envInt("BENCH_SCAN_ITERATIONS", 5),
	}
}

func percentile(values []float64, fraction float64) float64 {
	index := int(float64(len(values))*fraction+0.999999) - 1
	if index < 0 {
		index = 0
	}
	if index >= len(values) {
		index = len(values) - 1
	}
	return values[index]
}

func elapsedMS(started time.Time) float64 {
	return float64(time.Since(started).Microseconds()) / 1_000
}

func roundMillis(value float64) float64 {
	return float64(int64(value*1_000+0.5)) / 1_000
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(env(name, strconv.Itoa(fallback)))
	if err != nil || value <= 0 {
		fatal(fmt.Errorf("%s must be a positive integer", name))
	}
	return value
}

func writeJSON(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
