package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type agentProcess struct {
	command *exec.Cmd
	stdin   io.WriteCloser
	pending sync.Map
	writeMu sync.Mutex
	nextID  atomic.Int64
	reader  *bufio.Scanner
}

type agentResponse struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type benchmarkResult struct {
	Server          string  `json:"server"`
	Agent           string  `json:"agent"`
	Workload        string  `json:"workload"`
	Round           int     `json:"round"`
	Concurrency     int     `json:"concurrency"`
	Operations      int64   `json:"operations"`
	Errors          int64   `json:"errors"`
	DurationMS      float64 `json:"duration_ms"`
	QPS             float64 `json:"qps"`
	MeanMS          float64 `json:"mean_ms"`
	P50MS           float64 `json:"p50_ms"`
	P95MS           float64 `json:"p95_ms"`
	P99MS           float64 `json:"p99_ms"`
	StartupMS       float64 `json:"startup_ms,omitempty"`
	OpenSessionsMS  float64 `json:"open_sessions_ms,omitempty"`
	ReadyRSSKB      int64   `json:"ready_rss_kb,omitempty"`
	OneSessionRSSKB int64   `json:"one_session_rss_kb,omitempty"`
	SessionsRSSKB   int64   `json:"sessions_rss_kb,omitempty"`
	PeakRSSKB       int64   `json:"peak_rss_kb,omitempty"`
	PostLoadRSSKB   int64   `json:"post_load_rss_kb,omitempty"`
}

type runningAgent struct {
	name            string
	process         *agentProcess
	startup         time.Duration
	openSessions    time.Duration
	readyRSSKB      int64
	oneSessionRSSKB int64
	sessionsRSSKB   int64
	metricsPrinted  bool
}

func main() {
	host := requiredEnv("KINGBASE_HOST")
	port, err := strconv.Atoi(requiredEnv("KINGBASE_PORT"))
	if err != nil {
		panic(err)
	}
	database := requiredEnv("KINGBASE_DATABASE")
	username := requiredEnv("KINGBASE_USERNAME")
	password := requiredEnv("KINGBASE_PASSWORD")
	serverName := envOr("KINGBASE_SERVER", host+":"+strconv.Itoa(port))
	duration := time.Duration(envInt("BENCH_SECONDS", 4)) * time.Second
	rounds := envInt("BENCH_ROUNDS", 3)
	maxConcurrency := envInt("BENCH_MAX_CONCURRENCY", 32)
	concurrencies := envInts("BENCH_CONCURRENCIES", []int{1, 8, 32})
	benchmarkSQL := envOr("BENCH_SQL", "SELECT 1")
	benchmarkMaxRows := envInt("BENCH_MAX_ROWS", 1)
	workload := envOr("BENCH_WORKLOAD", "agent-select-literal")
	sampleMemory := os.Getenv("BENCH_SAMPLE_MEMORY") == "1"

	agents := []struct {
		name string
		argv []string
	}{
		{name: "go-gokb", argv: []string{requiredEnv("GO_AGENT")}},
		{name: "jdbc", argv: jdbcAgentCommand(requiredEnv("JDBC_AGENT_JAR"))},
	}
	encoder := json.NewEncoder(os.Stdout)
	running := make([]*runningAgent, 0, len(agents))
	for _, candidate := range agents {
		process, startup, err := startAgent(candidate.argv)
		if err != nil {
			panic(fmt.Errorf("start %s: %w", candidate.name, err))
		}
		params := map[string]any{"host": host, "port": port, "database": database, "username": username, "password": password}
		readyRSS := readRSSKB(process.command.Process.Pid)
		var oneSessionRSS int64
		openStart := time.Now()
		for index := 0; index < maxConcurrency; index++ {
			request := cloneMap(params)
			request["agentSessionId"] = sessionID(index)
			if _, err := process.call("open_session", request); err != nil {
				panic(fmt.Errorf("open %s session %d: %w", candidate.name, index, err))
			}
			if index == 0 {
				oneSessionRSS = readRSSKB(process.command.Process.Pid)
			}
		}
		openDuration := time.Since(openStart)
		running = append(running, &runningAgent{
			name: candidate.name, process: process, startup: startup, openSessions: openDuration,
			readyRSSKB: readyRSS, oneSessionRSSKB: oneSessionRSS, sessionsRSSKB: readRSSKB(process.command.Process.Pid),
		})
	}
	defer func() {
		for _, candidate := range running {
			_ = candidate.process.close()
		}
	}()
	for _, concurrency := range concurrencies {
		if concurrency > maxConcurrency {
			continue
		}
		for round := 1; round <= rounds; round++ {
			order := running
			if round%2 == 0 {
				order = []*runningAgent{running[1], running[0]}
			}
			for _, candidate := range order {
				result := runQueryBenchmark(candidate.process, duration, concurrency, benchmarkSQL, benchmarkMaxRows, sampleMemory)
				result.Server = serverName
				result.Agent = candidate.name
				result.Workload = workload
				result.Round = round
				if !candidate.metricsPrinted {
					result.StartupMS = float64(candidate.startup.Microseconds()) / 1000
					result.OpenSessionsMS = float64(candidate.openSessions.Microseconds()) / 1000
					candidate.metricsPrinted = true
				}
				if sampleMemory {
					result.ReadyRSSKB = candidate.readyRSSKB
					result.OneSessionRSSKB = candidate.oneSessionRSSKB
					result.SessionsRSSKB = candidate.sessionsRSSKB
					result.PostLoadRSSKB = readRSSKB(candidate.process.command.Process.Pid)
				}
				if err := encoder.Encode(result); err != nil {
					panic(err)
				}
			}
		}
	}
}

func jdbcAgentCommand(jarPath string) []string {
	return []string{
		"java",
		"-Dfile.encoding=UTF-8",
		"-Dsun.stdout.encoding=UTF-8",
		"-Dsun.stderr.encoding=UTF-8",
		"-Djava.net.useSystemProxies=false",
		"-Dhttp.proxyHost=",
		"-Dhttps.proxyHost=",
		"-DsocksProxyHost=",
		"-Doracle.net.disableOob=true",
		"-Doracle.jdbc.javaNetNio=false",
		"-Djava.net.preferIPv4Stack=true",
		"--add-opens=java.sql/java.sql=ALL-UNNAMED",
		"-XX:TieredStopAtLevel=1",
		"-XX:+UseSerialGC",
		"-jar",
		jarPath,
	}
}

func startAgent(argv []string) (*agentProcess, time.Duration, error) {
	if len(argv) == 0 {
		return nil, 0, errors.New("empty agent command")
	}
	process := &agentProcess{}
	process.command = exec.Command(argv[0], argv[1:]...)
	stdin, err := process.command.StdinPipe()
	if err != nil {
		return nil, 0, err
	}
	stdout, err := process.command.StdoutPipe()
	if err != nil {
		return nil, 0, err
	}
	process.command.Stderr = os.Stderr
	process.stdin = stdin
	process.reader = bufio.NewScanner(stdout)
	process.reader.Buffer(make([]byte, 64*1024), 512*1024*1024)
	start := time.Now()
	if err := process.command.Start(); err != nil {
		return nil, 0, err
	}
	if !process.reader.Scan() || !strings.Contains(process.reader.Text(), `"ready":true`) {
		return nil, 0, fmt.Errorf("agent did not become ready: %s", process.reader.Text())
	}
	startup := time.Since(start)
	go process.readResponses()
	return process, startup, nil
}

func (process *agentProcess) readResponses() {
	for process.reader.Scan() {
		var response agentResponse
		if json.Unmarshal(process.reader.Bytes(), &response) != nil {
			continue
		}
		if channel, ok := process.pending.LoadAndDelete(response.ID); ok {
			channel.(chan agentResponse) <- response
		}
	}
}

func (process *agentProcess) call(method string, params map[string]any) (json.RawMessage, error) {
	id := process.nextID.Add(1)
	channel := make(chan agentResponse, 1)
	process.pending.Store(id, channel)
	request := map[string]any{"id": id, "method": method, "params": params}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	process.writeMu.Lock()
	_, err = process.stdin.Write(append(payload, '\n'))
	process.writeMu.Unlock()
	if err != nil {
		process.pending.Delete(id)
		return nil, err
	}
	select {
	case response := <-channel:
		if response.Error != nil {
			return nil, errors.New(response.Error.Message)
		}
		return response.Result, nil
	case <-time.After(30 * time.Second):
		process.pending.Delete(id)
		return nil, errors.New("agent request timed out")
	}
}

func (process *agentProcess) close() error {
	_, _ = process.call("shutdown", map[string]any{})
	_ = process.stdin.Close()
	return process.command.Wait()
}

func runQueryBenchmark(process *agentProcess, duration time.Duration, concurrency int, sqlText string, maxRows int, sampleMemory bool) benchmarkResult {
	var operations atomic.Int64
	var failures atomic.Int64
	var peakRSS atomic.Int64
	stopMemory := make(chan struct{})
	if sampleMemory {
		peakRSS.Store(readRSSKB(process.command.Process.Pid))
		go func() {
			ticker := time.NewTicker(100 * time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					value := readRSSKB(process.command.Process.Pid)
					for value > peakRSS.Load() && !peakRSS.CompareAndSwap(peakRSS.Load(), value) {
					}
				case <-stopMemory:
					return
				}
			}
		}()
	}
	latencies := make([][]float64, concurrency)
	start := time.Now()
	deadline := start.Add(duration)
	var workers sync.WaitGroup
	for worker := 0; worker < concurrency; worker++ {
		worker := worker
		workers.Add(1)
		go func() {
			defer workers.Done()
			local := make([]float64, 0, 4096)
			params := map[string]any{"agentSessionId": sessionID(worker), "sql": sqlText, "maxRows": maxRows}
			for time.Now().Before(deadline) {
				callStart := time.Now()
				_, err := process.call("execute_query", params)
				local = append(local, float64(time.Since(callStart).Microseconds())/1000)
				operations.Add(1)
				if err != nil {
					failures.Add(1)
				}
			}
			latencies[worker] = local
		}()
	}
	workers.Wait()
	if sampleMemory {
		close(stopMemory)
	}
	elapsed := time.Since(start)
	merged := []float64{}
	for _, values := range latencies {
		merged = append(merged, values...)
	}
	sort.Float64s(merged)
	var total float64
	for _, value := range merged {
		total += value
	}
	count := operations.Load()
	return benchmarkResult{
		Concurrency: concurrency, Operations: count, Errors: failures.Load(), DurationMS: float64(elapsed.Microseconds()) / 1000,
		QPS: float64(count) / elapsed.Seconds(), MeanMS: total / float64(max(1, len(merged))),
		P50MS: percentile(merged, 0.50), P95MS: percentile(merged, 0.95), P99MS: percentile(merged, 0.99),
		PeakRSSKB: peakRSS.Load(),
	}
}

func readRSSKB(pid int) int64 {
	output, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	value, _ := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	return value
}

func percentile(values []float64, fraction float64) float64 {
	if len(values) == 0 {
		return 0
	}
	index := int(float64(len(values)-1) * fraction)
	return values[index]
}

func sessionID(index int) string { return "bench-" + strconv.Itoa(index) }

func cloneMap(source map[string]any) map[string]any {
	result := make(map[string]any, len(source)+1)
	for key, value := range source {
		result[key] = value
	}
	return result
}

func requiredEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		panic(name + " is required")
	}
	return value
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func envInts(name string, fallback []int) []int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	result := []int{}
	for _, item := range strings.Split(raw, ",") {
		value, err := strconv.Atoi(strings.TrimSpace(item))
		if err == nil && value > 0 {
			result = append(result, value)
		}
	}
	if len(result) == 0 {
		return fallback
	}
	return result
}
