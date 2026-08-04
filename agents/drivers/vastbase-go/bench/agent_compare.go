package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type agentSpec struct {
	Name         string
	Command      []string
	ArtifactPath string
}

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

type benchmarkMetadata struct {
	Type              string            `json:"type"`
	Server            string            `json:"server,omitempty"`
	DatabaseVersions  map[string]string `json:"database_versions,omitempty"`
	GOOS              string            `json:"goos"`
	GOARCH            string            `json:"goarch"`
	Phases            []string          `json:"phases"`
	Rounds            int               `json:"rounds"`
	DurationSeconds   int               `json:"duration_seconds"`
	Concurrencies     []int             `json:"concurrencies"`
	StartupWarmups    int               `json:"startup_warmups"`
	StartupIterations int               `json:"startup_iterations"`
	ConnectWarmups    int               `json:"connect_warmups"`
	ConnectIterations int               `json:"connect_iterations"`
	QueryWarmups      int               `json:"query_warmups"`
	Workloads         []string          `json:"workloads"`
}

type benchmarkResult struct {
	Type          string  `json:"type"`
	Server        string  `json:"server,omitempty"`
	Agent         string  `json:"agent"`
	Workload      string  `json:"workload"`
	Round         int     `json:"round"`
	Concurrency   int     `json:"concurrency"`
	Operations    int64   `json:"operations"`
	Errors        int64   `json:"errors"`
	DurationMS    float64 `json:"duration_ms"`
	QPS           float64 `json:"qps"`
	MeanMS        float64 `json:"mean_ms"`
	P50MS         float64 `json:"p50_ms"`
	P95MS         float64 `json:"p95_ms"`
	P99MS         float64 `json:"p99_ms"`
	ReadyRSSKB    int64   `json:"ready_rss_kb,omitempty"`
	OneSessionKB  int64   `json:"one_session_rss_kb,omitempty"`
	AllSessionsKB int64   `json:"all_sessions_rss_kb,omitempty"`
	PeakRSSKB     int64   `json:"peak_rss_kb,omitempty"`
	ArtifactBytes int64   `json:"artifact_bytes,omitempty"`
}

type runningAgent struct {
	spec            agentSpec
	process         *agentProcess
	readyRSSKB      int64
	oneSessionRSSKB int64
	allSessionsRSS  int64
}

type workload struct {
	Name       string
	Method     string
	Parameters func(worker int) map[string]any
	Cleanup    func(*agentProcess, json.RawMessage, int) error
}

func main() {
	agents := []agentSpec{
		{
			Name:         "jdbc-2.11v",
			Command:      jdbcAgentCommand(requiredEnv("JDBC_211_AGENT_JAR")),
			ArtifactPath: requiredEnv("JDBC_211_AGENT_JAR"),
		},
		{
			Name:         "jdbc-2.15v",
			Command:      jdbcAgentCommand(requiredEnv("JDBC_215_AGENT_JAR")),
			ArtifactPath: requiredEnv("JDBC_215_AGENT_JAR"),
		},
		{
			Name:         "go-v1.0.8",
			Command:      []string{requiredEnv("GO_AGENT")},
			ArtifactPath: requiredEnv("GO_AGENT"),
		},
	}
	for _, agent := range agents {
		if _, err := os.Stat(agent.ArtifactPath); err != nil {
			panic(fmt.Errorf("stat %s artifact %s: %w", agent.Name, agent.ArtifactPath, err))
		}
	}

	phases := envStrings("BENCH_PHASES", []string{"startup", "connect", "query"})
	rounds := envInt("BENCH_ROUNDS", 3)
	durationSeconds := envInt("BENCH_SECONDS", 4)
	concurrencies := envInts("BENCH_CONCURRENCIES", []int{1, 8, 32})
	startupWarmups := envNonNegativeInt("BENCH_STARTUP_WARMUPS", 2)
	startupIterations := envInt("BENCH_STARTUPS", 20)
	connectWarmups := envNonNegativeInt("BENCH_CONNECT_WARMUPS", 3)
	connectIterations := envInt("BENCH_CONNECTS", 30)
	queryWarmups := envNonNegativeInt("BENCH_QUERY_WARMUPS", 20)
	workloadNames := envStrings("BENCH_WORKLOADS", []string{"select_literal", "decode_rows", "page_rows", "list_tables"})
	serverName := os.Getenv("VASTBASE_SERVER")

	encoder := json.NewEncoder(os.Stdout)
	metadata := benchmarkMetadata{
		Type:              "metadata",
		Server:            serverName,
		GOOS:              runtime.GOOS,
		GOARCH:            runtime.GOARCH,
		Phases:            phases,
		Rounds:            rounds,
		DurationSeconds:   durationSeconds,
		Concurrencies:     concurrencies,
		StartupWarmups:    startupWarmups,
		StartupIterations: startupIterations,
		ConnectWarmups:    connectWarmups,
		ConnectIterations: connectIterations,
		QueryWarmups:      queryWarmups,
		Workloads:         workloadNames,
	}
	encode(encoder, metadata)

	if contains(phases, "startup") {
		for _, result := range benchmarkStartups(agents, startupWarmups, startupIterations) {
			encode(encoder, result)
		}
	}
	if !contains(phases, "connect") && !contains(phases, "query") {
		return
	}

	connection := connectionParams()
	if serverName == "" {
		serverName = fmt.Sprintf("%s:%v", connection["host"], connection["port"])
	}
	maxConcurrency := maxInt(concurrencies)
	running := startPersistentAgents(agents)
	defer func() {
		for _, candidate := range running {
			_ = candidate.process.close()
		}
	}()

	versions := preflightVersions(running, connection)
	metadata.Server = serverName
	metadata.DatabaseVersions = versions
	encode(encoder, metadata)

	if contains(phases, "connect") {
		for _, result := range benchmarkConnections(running, connection, connectWarmups, connectIterations) {
			result.Server = serverName
			encode(encoder, result)
		}
	}
	if !contains(phases, "query") {
		return
	}

	openSessions(running, connection, maxConcurrency)
	workloads := configuredWorkloads(workloadNames)
	for _, benchmark := range workloads {
		for _, concurrency := range concurrencies {
			for round := 1; round <= rounds; round++ {
				for _, candidate := range rotatedAgents(running, round+concurrency) {
					warmup(candidate.process, benchmark, concurrency, queryWarmups)
					result := runWorkload(
						candidate.process,
						benchmark,
						time.Duration(durationSeconds)*time.Second,
						concurrency,
					)
					result.Server = serverName
					result.Agent = candidate.spec.Name
					result.Round = round
					result.ReadyRSSKB = candidate.readyRSSKB
					result.OneSessionKB = candidate.oneSessionRSSKB
					result.AllSessionsKB = candidate.allSessionsRSS
					result.ArtifactBytes = fileSize(candidate.spec.ArtifactPath)
					encode(encoder, result)
				}
			}
		}
	}
}

func benchmarkStartups(agents []agentSpec, warmups, iterations int) []benchmarkResult {
	for iteration := 0; iteration < warmups; iteration++ {
		for _, agent := range rotatedSpecs(agents, iteration) {
			process, _, err := startAgent(agent.Command)
			if err != nil {
				panic(fmt.Errorf("warm startup %s: %w", agent.Name, err))
			}
			if _, err := process.call("handshake", map[string]any{}); err != nil {
				process.kill()
				panic(fmt.Errorf("warm handshake %s: %w", agent.Name, err))
			}
			if err := process.close(); err != nil {
				panic(fmt.Errorf("close startup warmup %s: %w", agent.Name, err))
			}
		}
	}

	readySamples := map[string][]float64{}
	handshakeSamples := map[string][]float64{}
	rssSamples := map[string][]int64{}
	for iteration := 0; iteration < iterations; iteration++ {
		for _, agent := range rotatedSpecs(agents, iteration) {
			process, readyDuration, err := startAgent(agent.Command)
			if err != nil {
				panic(fmt.Errorf("start %s: %w", agent.Name, err))
			}
			handshakeStart := time.Now()
			if _, err := process.call("handshake", map[string]any{}); err != nil {
				process.kill()
				panic(fmt.Errorf("handshake %s: %w", agent.Name, err))
			}
			readySamples[agent.Name] = append(readySamples[agent.Name], milliseconds(readyDuration))
			handshakeSamples[agent.Name] = append(
				handshakeSamples[agent.Name],
				milliseconds(readyDuration+time.Since(handshakeStart)),
			)
			rssSamples[agent.Name] = append(rssSamples[agent.Name], readRSSKB(process.command.Process.Pid))
			if err := process.close(); err != nil {
				panic(fmt.Errorf("close startup %s: %w", agent.Name, err))
			}
		}
	}

	results := make([]benchmarkResult, 0, len(agents)*2)
	for _, agent := range agents {
		ready := summarize(agent.Name, "startup_ready", 0, readySamples[agent.Name])
		ready.ReadyRSSKB = medianInt64(rssSamples[agent.Name])
		ready.ArtifactBytes = fileSize(agent.ArtifactPath)
		results = append(results, ready)

		withHandshake := summarize(agent.Name, "startup_handshake", 0, handshakeSamples[agent.Name])
		withHandshake.ReadyRSSKB = medianInt64(rssSamples[agent.Name])
		withHandshake.ArtifactBytes = fileSize(agent.ArtifactPath)
		results = append(results, withHandshake)
	}
	return results
}

func startPersistentAgents(agents []agentSpec) []*runningAgent {
	running := make([]*runningAgent, 0, len(agents))
	for _, agent := range agents {
		process, _, err := startAgent(agent.Command)
		if err != nil {
			panic(fmt.Errorf("start persistent %s: %w", agent.Name, err))
		}
		if _, err := process.call("handshake", map[string]any{}); err != nil {
			process.kill()
			panic(fmt.Errorf("handshake persistent %s: %w", agent.Name, err))
		}
		running = append(running, &runningAgent{
			spec:       agent,
			process:    process,
			readyRSSKB: readRSSKB(process.command.Process.Pid),
		})
	}
	return running
}

func preflightVersions(running []*runningAgent, connection map[string]any) map[string]string {
	versions := map[string]string{}
	for _, candidate := range running {
		params := cloneMap(connection)
		params["agentSessionId"] = "preflight"
		if _, err := candidate.process.call("open_session", params); err != nil {
			panic(fmt.Errorf("preflight connect %s: %w", candidate.spec.Name, err))
		}
		result, err := candidate.process.call("execute_query", map[string]any{
			"agentSessionId": "preflight",
			"sql":            "SELECT version()",
			"maxRows":        1,
		})
		if err != nil {
			panic(fmt.Errorf("preflight version %s: %w", candidate.spec.Name, err))
		}
		versions[candidate.spec.Name] = firstCell(result)
		if _, err := candidate.process.call("close_session", map[string]any{"agentSessionId": "preflight"}); err != nil {
			panic(fmt.Errorf("close preflight %s: %w", candidate.spec.Name, err))
		}
	}
	return versions
}

func benchmarkConnections(
	running []*runningAgent,
	connection map[string]any,
	warmups int,
	iterations int,
) []benchmarkResult {
	for iteration := 0; iteration < warmups; iteration++ {
		for _, candidate := range rotatedAgents(running, iteration) {
			benchmarkOneConnection(candidate, connection, fmt.Sprintf("connect-warmup-%d", iteration))
		}
	}

	samples := map[string][]float64{}
	for iteration := 0; iteration < iterations; iteration++ {
		for _, candidate := range rotatedAgents(running, iteration) {
			start := time.Now()
			benchmarkOneConnection(candidate, connection, fmt.Sprintf("connect-%d", iteration))
			samples[candidate.spec.Name] = append(samples[candidate.spec.Name], milliseconds(time.Since(start)))
		}
	}

	results := make([]benchmarkResult, 0, len(running))
	for _, candidate := range running {
		result := summarize(candidate.spec.Name, "connect_auth_close", 1, samples[candidate.spec.Name])
		result.ReadyRSSKB = readRSSKB(candidate.process.command.Process.Pid)
		result.ArtifactBytes = fileSize(candidate.spec.ArtifactPath)
		results = append(results, result)
	}
	return results
}

func benchmarkOneConnection(candidate *runningAgent, connection map[string]any, session string) {
	params := cloneMap(connection)
	params["agentSessionId"] = session
	if _, err := candidate.process.call("open_session", params); err != nil {
		panic(fmt.Errorf("open connection %s: %w", candidate.spec.Name, err))
	}
	if _, err := candidate.process.call("close_session", map[string]any{"agentSessionId": session}); err != nil {
		panic(fmt.Errorf("close connection %s: %w", candidate.spec.Name, err))
	}
}

func openSessions(running []*runningAgent, connection map[string]any, count int) {
	for _, candidate := range running {
		for index := 0; index < count; index++ {
			params := cloneMap(connection)
			params["agentSessionId"] = sessionID(index)
			if _, err := candidate.process.call("open_session", params); err != nil {
				panic(fmt.Errorf("open %s session %d: %w", candidate.spec.Name, index, err))
			}
			if index == 0 {
				candidate.oneSessionRSSKB = readRSSKB(candidate.process.command.Process.Pid)
			}
		}
		candidate.allSessionsRSS = readRSSKB(candidate.process.command.Process.Pid)
	}
}

func configuredWorkloads(names []string) []workload {
	literalSQL := envOr("BENCH_LITERAL_SQL", "SELECT 1 AS value")
	decodeRows := envInt("BENCH_DECODE_ROWS", 1000)
	decodeSQL := envOr(
		"BENCH_DECODE_SQL",
		fmt.Sprintf(
			"SELECT value AS id, CAST(value * 1.25 AS numeric(18,2)) AS numeric_value, "+
				"CAST('2024-01-02 03:04:05' AS timestamp) AS timestamp_value, repeat('x', 64) AS text_value "+
				"FROM generate_series(1, %d) AS value",
			decodeRows,
		),
	)
	pageRows := envInt("BENCH_PAGE_ROWS", decodeRows)
	pageSQL := envOr("BENCH_PAGE_SQL", decodeSQL)
	schema := envOr("BENCH_SCHEMA", "public")

	available := map[string]workload{
		"select_literal": {
			Name:   "select_literal",
			Method: "execute_query",
			Parameters: func(worker int) map[string]any {
				return map[string]any{
					"agentSessionId": sessionID(worker),
					"sql":            literalSQL,
					"maxRows":        1,
				}
			},
		},
		"decode_rows": {
			Name:   "decode_rows",
			Method: "execute_query",
			Parameters: func(worker int) map[string]any {
				return map[string]any{
					"agentSessionId": sessionID(worker),
					"sql":            decodeSQL,
					"maxRows":        decodeRows,
					"fetchSize":      decodeRows,
				}
			},
		},
		"page_rows": {
			Name:   "page_rows",
			Method: "execute_query_page",
			Parameters: func(worker int) map[string]any {
				return map[string]any{
					"agentSessionId": sessionID(worker),
					"sql":            pageSQL,
					"pageSize":       pageRows,
					"fetchSize":      pageRows,
					"maxRows":        pageRows,
				}
			},
			Cleanup: cleanupQueryPage,
		},
		"list_tables": {
			Name:   "list_tables",
			Method: "list_tables",
			Parameters: func(worker int) map[string]any {
				return map[string]any{"agentSessionId": sessionID(worker), "schema": schema}
			},
		},
	}

	result := make([]workload, 0, len(names))
	for _, name := range names {
		benchmark, ok := available[name]
		if !ok {
			panic("unknown BENCH_WORKLOADS entry: " + name)
		}
		result = append(result, benchmark)
	}
	return result
}

func cleanupQueryPage(process *agentProcess, result json.RawMessage, worker int) error {
	var page struct {
		SessionID string `json:"sessionId"`
		Done      bool   `json:"done"`
	}
	if err := json.Unmarshal(result, &page); err != nil || page.Done || page.SessionID == "" {
		return err
	}
	_, err := process.call("close_query_session", map[string]any{
		"agentSessionId": sessionID(worker),
		"sessionId":      page.SessionID,
	})
	return err
}

func warmup(process *agentProcess, benchmark workload, concurrency, operations int) {
	if operations == 0 {
		return
	}
	for iteration := 0; iteration < operations; iteration++ {
		worker := iteration % concurrency
		result, err := process.call(benchmark.Method, benchmark.Parameters(worker))
		if err != nil {
			panic(fmt.Errorf("warmup %s: %w", benchmark.Name, err))
		}
		if benchmark.Cleanup != nil {
			if err := benchmark.Cleanup(process, result, worker); err != nil {
				panic(fmt.Errorf("warmup cleanup %s: %w", benchmark.Name, err))
			}
		}
	}
}

func runWorkload(process *agentProcess, benchmark workload, duration time.Duration, concurrency int) benchmarkResult {
	var operations atomic.Int64
	var failures atomic.Int64
	var peakRSS atomic.Int64
	peakRSS.Store(readRSSKB(process.command.Process.Pid))
	stopMemory := make(chan struct{})
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
			for time.Now().Before(deadline) {
				callStart := time.Now()
				result, err := process.call(benchmark.Method, benchmark.Parameters(worker))
				if err == nil && benchmark.Cleanup != nil {
					err = benchmark.Cleanup(process, result, worker)
				}
				local = append(local, milliseconds(time.Since(callStart)))
				operations.Add(1)
				if err != nil {
					failures.Add(1)
				}
			}
			latencies[worker] = local
		}()
	}
	workers.Wait()
	close(stopMemory)
	elapsed := time.Since(start)

	merged := make([]float64, 0)
	for _, values := range latencies {
		merged = append(merged, values...)
	}
	result := summarize("", benchmark.Name, concurrency, merged)
	result.DurationMS = milliseconds(elapsed)
	result.QPS = float64(operations.Load()) / elapsed.Seconds()
	result.Operations = operations.Load()
	result.Errors = failures.Load()
	result.PeakRSSKB = peakRSS.Load()
	return result
}

func startAgent(argv []string) (*agentProcess, time.Duration, error) {
	if len(argv) == 0 {
		return nil, 0, errors.New("agent command is empty")
	}
	command := exec.Command(argv[0], argv[1:]...)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, 0, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, 0, err
	}
	command.Stderr = os.Stderr
	process := &agentProcess{command: command, stdin: stdin, reader: bufio.NewScanner(stdout)}
	process.reader.Buffer(make([]byte, 0, 64*1024), 512*1024*1024)
	start := time.Now()
	if err := command.Start(); err != nil {
		return nil, 0, err
	}
	if !process.reader.Scan() {
		return nil, 0, errors.New("agent exited before ready")
	}
	if !strings.Contains(process.reader.Text(), `"ready":true`) {
		process.kill()
		return nil, 0, fmt.Errorf("agent did not become ready: %s", process.reader.Text())
	}
	readyDuration := time.Since(start)
	go process.readResponses()
	return process, readyDuration, nil
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
		process.pending.Delete(id)
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
	case <-time.After(60 * time.Second):
		process.pending.Delete(id)
		return nil, errors.New("agent request timed out")
	}
}

func (process *agentProcess) close() error {
	_, _ = process.call("shutdown", map[string]any{})
	_ = process.stdin.Close()
	return process.command.Wait()
}

func (process *agentProcess) kill() {
	if process.command.Process != nil {
		_ = process.command.Process.Kill()
	}
}

func connectionParams() map[string]any {
	port, err := strconv.Atoi(requiredEnv("VASTBASE_PORT"))
	if err != nil {
		panic(fmt.Errorf("parse VASTBASE_PORT: %w", err))
	}
	return map[string]any{
		"host":              requiredEnv("VASTBASE_HOST"),
		"port":              port,
		"database":          requiredEnv("VASTBASE_DATABASE"),
		"username":          requiredEnv("VASTBASE_USERNAME"),
		"password":          requiredEnv("VASTBASE_PASSWORD"),
		"url_params":        os.Getenv("VASTBASE_URL_PARAMS"),
		"connection_string": os.Getenv("VASTBASE_CONNECTION_STRING"),
		"ssl":               envBool("VASTBASE_SSL", false),
		"ca_cert_path":      os.Getenv("VASTBASE_CA_CERT_PATH"),
		"client_cert_path":  os.Getenv("VASTBASE_CLIENT_CERT_PATH"),
		"client_key_path":   os.Getenv("VASTBASE_CLIENT_KEY_PATH"),
	}
}

func jdbcAgentCommand(jar string) []string {
	java := os.Getenv("DBX_AGENT_JAVA")
	if java == "" {
		java = "java"
	}
	return []string{java, "-Xms32m", "-Xmx512m", "-jar", jar}
}

func summarize(agent, workload string, concurrency int, values []float64) benchmarkResult {
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	var total float64
	for _, value := range sorted {
		total += value
	}
	durationMS := total
	qps := 0.0
	if durationMS > 0 {
		qps = float64(len(sorted)) / (durationMS / 1000)
	}
	return benchmarkResult{
		Type:        "result",
		Agent:       agent,
		Workload:    workload,
		Concurrency: concurrency,
		Operations:  int64(len(sorted)),
		DurationMS:  durationMS,
		QPS:         qps,
		MeanMS:      total / float64(maxInt([]int{1, len(sorted)})),
		P50MS:       percentile(sorted, 0.50),
		P95MS:       percentile(sorted, 0.95),
		P99MS:       percentile(sorted, 0.99),
	}
}

func percentile(values []float64, fraction float64) float64 {
	if len(values) == 0 {
		return 0
	}
	index := int(float64(len(values)-1) * fraction)
	return values[index]
}

func firstCell(result json.RawMessage) string {
	var query struct {
		Rows [][]any `json:"rows"`
	}
	if json.Unmarshal(result, &query) != nil || len(query.Rows) == 0 || len(query.Rows[0]) == 0 {
		return ""
	}
	return fmt.Sprint(query.Rows[0][0])
}

func rotatedSpecs(values []agentSpec, offset int) []agentSpec {
	if len(values) == 0 {
		return nil
	}
	start := offset % len(values)
	result := make([]agentSpec, 0, len(values))
	result = append(result, values[start:]...)
	result = append(result, values[:start]...)
	return result
}

func rotatedAgents(values []*runningAgent, offset int) []*runningAgent {
	if len(values) == 0 {
		return nil
	}
	start := offset % len(values)
	result := make([]*runningAgent, 0, len(values))
	result = append(result, values[start:]...)
	result = append(result, values[:start]...)
	return result
}

func readRSSKB(pid int) int64 {
	output, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	value, _ := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	return value
}

func medianInt64(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
	return sorted[len(sorted)/2]
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

func cloneMap(source map[string]any) map[string]any {
	result := make(map[string]any, len(source)+1)
	for key, value := range source {
		result[key] = value
	}
	return result
}

func sessionID(index int) string {
	return "bench-" + strconv.Itoa(index)
}

func encode(encoder *json.Encoder, value any) {
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
}

func milliseconds(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func maxInt(values []int) int {
	result := 0
	for _, value := range values {
		if value > result {
			result = value
		}
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

func envNonNegativeInt(name string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(name))
	if err != nil || value < 0 {
		return fallback
	}
	return value
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		panic(fmt.Errorf("parse %s: %w", name, err))
	}
	return parsed
}

func envStrings(name string, fallback []string) []string {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	result := make([]string, 0)
	for _, item := range strings.Split(raw, ",") {
		if value := strings.TrimSpace(item); value != "" {
			result = append(result, value)
		}
	}
	if len(result) == 0 {
		return fallback
	}
	return result
}

func envInts(name string, fallback []int) []int {
	items := envStrings(name, nil)
	if len(items) == 0 {
		return fallback
	}
	result := make([]int, 0, len(items))
	for _, item := range items {
		value, err := strconv.Atoi(item)
		if err != nil || value <= 0 {
			panic(name + " must contain positive integers")
		}
		result = append(result, value)
	}
	return result
}
