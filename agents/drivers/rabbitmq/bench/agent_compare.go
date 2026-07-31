package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strconv"
	"strings"
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
	reader  *bufio.Scanner
	nextID  int64
}

type agentResponse struct {
	ID     int64           `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type benchmarkResult struct {
	Agent         string  `json:"agent"`
	Workload      string  `json:"workload"`
	Round         int     `json:"round"`
	Operations    int     `json:"operations"`
	Errors        int     `json:"errors"`
	DurationMS    float64 `json:"duration_ms"`
	QPS           float64 `json:"qps"`
	MeanMS        float64 `json:"mean_ms"`
	P50MS         float64 `json:"p50_ms"`
	P95MS         float64 `json:"p95_ms"`
	P99MS         float64 `json:"p99_ms"`
	ReadyRSSKB    int64   `json:"ready_rss_kb,omitempty"`
	PostLoadRSSKB int64   `json:"post_load_rss_kb,omitempty"`
	ArtifactBytes int64   `json:"artifact_bytes,omitempty"`
}

type benchmarkMetadata struct {
	Type              string `json:"type"`
	GOOS              string `json:"goos"`
	GOARCH            string `json:"goarch"`
	Rounds            int    `json:"rounds"`
	StartupWarmups    int    `json:"startup_warmups"`
	StartupIterations int    `json:"startup_iterations"`
	WarmupRequests    int    `json:"warmup_requests"`
	RPCRequests       int    `json:"rpc_requests"`
	ManagementCalls   int    `json:"management_requests"`
}

func main() {
	rounds := envInt("BENCH_ROUNDS", 5)
	startupWarmups := envInt("BENCH_STARTUP_WARMUPS", 3)
	startupIterations := envInt("BENCH_STARTUPS", 30)
	warmupRequests := envInt("BENCH_WARMUP_REQUESTS", 500)
	rpcRequests := envInt("BENCH_RPC_REQUESTS", 5000)
	managementRequests := envInt("BENCH_MANAGEMENT_REQUESTS", 1000)

	agents := []agentSpec{
		{
			Name:         "java",
			Command:      javaAgentCommand(requiredEnv("JAVA_AGENT_JAR")),
			ArtifactPath: requiredEnv("JAVA_AGENT_JAR"),
		},
		{
			Name:         "go",
			Command:      []string{requiredEnv("GO_AGENT")},
			ArtifactPath: requiredEnv("GO_AGENT"),
		},
	}

	encoder := json.NewEncoder(os.Stdout)
	encode(encoder, benchmarkMetadata{
		Type:              "metadata",
		GOOS:              runtime.GOOS,
		GOARCH:            runtime.GOARCH,
		Rounds:            rounds,
		StartupWarmups:    startupWarmups,
		StartupIterations: startupIterations,
		WarmupRequests:    warmupRequests,
		RPCRequests:       rpcRequests,
		ManagementCalls:   managementRequests,
	})

	for _, result := range benchmarkStartups(agents, startupWarmups, startupIterations) {
		encode(encoder, result)
	}

	managementURL, closeManagementServer := startManagementServer()
	defer closeManagementServer()
	managementParams := map[string]any{
		"connection": map[string]any{
			"management_url": managementURL,
			"username":       "guest",
			"password":       "guest",
			"virtual_host":   "/",
		},
	}

	for round := 1; round <= rounds; round++ {
		order := agents
		if round%2 == 0 {
			order = []agentSpec{agents[1], agents[0]}
		}
		for _, agent := range order {
			encode(encoder, benchmarkRPC(agent, "handshake", round, "handshake", map[string]any{}, warmupRequests, rpcRequests))
			encode(encoder, benchmarkRPC(
				agent,
				"management_list_topics",
				round,
				"mq_list_topics",
				managementParams,
				warmupRequests/5,
				managementRequests,
			))
		}
	}
}

func benchmarkStartups(agents []agentSpec, warmups, iterations int) []benchmarkResult {
	for warmup := 0; warmup < warmups; warmup++ {
		order := agents
		if warmup%2 == 1 {
			order = []agentSpec{agents[1], agents[0]}
		}
		for _, agent := range order {
			process, _, err := startAgent(agent.Command)
			if err != nil {
				panic(fmt.Errorf("warm up startup %s: %w", agent.Name, err))
			}
			if _, err := process.call("handshake", map[string]any{}); err != nil {
				process.kill()
				panic(fmt.Errorf("warm up handshake %s: %w", agent.Name, err))
			}
			if err := process.close(); err != nil {
				panic(fmt.Errorf("close startup warmup %s: %w", agent.Name, err))
			}
		}
	}

	readySamples := map[string][]float64{}
	handshakeSamples := map[string][]float64{}
	rssSamples := map[string][]int64{}
	readyDurations := map[string]time.Duration{}
	handshakeDurations := map[string]time.Duration{}
	for iteration := 0; iteration < iterations; iteration++ {
		order := agents
		if iteration%2 == 1 {
			order = []agentSpec{agents[1], agents[0]}
		}
		for _, agent := range order {
			process, readyDuration, err := startAgent(agent.Command)
			if err != nil {
				panic(fmt.Errorf("start %s: %w", agent.Name, err))
			}
			handshakeStart := time.Now()
			if _, err := process.call("handshake", map[string]any{}); err != nil {
				process.kill()
				panic(fmt.Errorf("handshake %s: %w", agent.Name, err))
			}
			handshakeDuration := time.Since(handshakeStart)
			readySamples[agent.Name] = append(readySamples[agent.Name], milliseconds(readyDuration))
			handshakeSamples[agent.Name] = append(
				handshakeSamples[agent.Name],
				milliseconds(readyDuration+handshakeDuration),
			)
			rssSamples[agent.Name] = append(rssSamples[agent.Name], readRSSKB(process.command.Process.Pid))
			readyDurations[agent.Name] += readyDuration
			handshakeDurations[agent.Name] += readyDuration + handshakeDuration
			if err := process.close(); err != nil {
				panic(fmt.Errorf("close %s: %w", agent.Name, err))
			}
		}
	}

	results := make([]benchmarkResult, 0, len(agents)*2)
	for _, agent := range agents {
		artifactBytes := fileSize(agent.ArtifactPath)
		ready := summarize(agent.Name, "startup_ready", 0, readySamples[agent.Name], readyDurations[agent.Name], 0)
		ready.ReadyRSSKB = medianInt64(rssSamples[agent.Name])
		ready.ArtifactBytes = artifactBytes
		results = append(results, ready)
		withHandshake := summarize(
			agent.Name,
			"startup_handshake",
			0,
			handshakeSamples[agent.Name],
			handshakeDurations[agent.Name],
			0,
		)
		withHandshake.ReadyRSSKB = medianInt64(rssSamples[agent.Name])
		withHandshake.ArtifactBytes = artifactBytes
		results = append(results, withHandshake)
	}
	return results
}

func benchmarkRPC(
	agent agentSpec,
	workload string,
	round int,
	method string,
	params map[string]any,
	warmupRequests int,
	operations int,
) benchmarkResult {
	process, _, err := startAgent(agent.Command)
	if err != nil {
		panic(fmt.Errorf("start %s: %w", agent.Name, err))
	}
	defer func() {
		if err := process.close(); err != nil {
			panic(fmt.Errorf("close %s: %w", agent.Name, err))
		}
	}()
	readyRSS := readRSSKB(process.command.Process.Pid)
	for request := 0; request < warmupRequests; request++ {
		if _, err := process.call(method, params); err != nil {
			panic(fmt.Errorf("warm up %s/%s: %w", agent.Name, workload, err))
		}
	}

	latencies := make([]float64, 0, operations)
	errorsCount := 0
	start := time.Now()
	for operation := 0; operation < operations; operation++ {
		requestStart := time.Now()
		if _, err := process.call(method, params); err != nil {
			errorsCount++
		}
		latencies = append(latencies, milliseconds(time.Since(requestStart)))
	}
	duration := time.Since(start)
	result := summarize(agent.Name, workload, round, latencies, duration, errorsCount)
	result.ReadyRSSKB = readyRSS
	result.PostLoadRSSKB = readRSSKB(process.command.Process.Pid)
	result.ArtifactBytes = fileSize(agent.ArtifactPath)
	return result
}

func summarize(
	agent string,
	workload string,
	round int,
	latencies []float64,
	duration time.Duration,
	errorsCount int,
) benchmarkResult {
	sorted := append([]float64(nil), latencies...)
	sort.Float64s(sorted)
	total := 0.0
	for _, latency := range sorted {
		total += latency
	}
	operations := len(sorted)
	mean := 0.0
	qps := 0.0
	if operations > 0 {
		mean = total / float64(operations)
	}
	if duration > 0 {
		qps = float64(operations) / duration.Seconds()
	}
	return benchmarkResult{
		Agent:      agent,
		Workload:   workload,
		Round:      round,
		Operations: operations,
		Errors:     errorsCount,
		DurationMS: milliseconds(duration),
		QPS:        qps,
		MeanMS:     mean,
		P50MS:      percentile(sorted, 0.50),
		P95MS:      percentile(sorted, 0.95),
		P99MS:      percentile(sorted, 0.99),
	}
}

func startAgent(command []string) (*agentProcess, time.Duration, error) {
	if len(command) == 0 {
		return nil, 0, errors.New("empty agent command")
	}
	process := &agentProcess{}
	process.command = exec.Command(command[0], command[1:]...)
	process.command.Env = sanitizedEnv()
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
	if !process.reader.Scan() {
		process.kill()
		return nil, 0, fmt.Errorf("agent did not become ready: %v", process.reader.Err())
	}
	if !strings.Contains(process.reader.Text(), `"ready":true`) {
		process.kill()
		return nil, 0, fmt.Errorf("agent did not become ready: %s", process.reader.Text())
	}
	return process, time.Since(start), nil
}

func (process *agentProcess) call(method string, params map[string]any) (json.RawMessage, error) {
	process.nextID++
	request := map[string]any{
		"jsonrpc": "2.0",
		"id":      process.nextID,
		"method":  method,
		"params":  params,
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if _, err := process.stdin.Write(append(payload, '\n')); err != nil {
		return nil, err
	}
	if !process.reader.Scan() {
		return nil, fmt.Errorf("agent response unavailable: %v", process.reader.Err())
	}
	var response agentResponse
	if err := json.Unmarshal(process.reader.Bytes(), &response); err != nil {
		return nil, err
	}
	if response.ID != process.nextID {
		return nil, fmt.Errorf("response id %d does not match request id %d", response.ID, process.nextID)
	}
	if response.Error != nil {
		return nil, errors.New(response.Error.Message)
	}
	return response.Result, nil
}

func (process *agentProcess) close() error {
	_, callError := process.call("shutdown", map[string]any{})
	_ = process.stdin.Close()
	waitError := process.command.Wait()
	if callError != nil {
		return callError
	}
	return waitError
}

func (process *agentProcess) kill() {
	if process != nil && process.command != nil && process.command.Process != nil {
		_ = process.command.Process.Kill()
		_, _ = process.command.Process.Wait()
	}
}

func startManagementServer() (string, func()) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	queues := make([]map[string]any, 0, 12)
	for index := 11; index >= 0; index-- {
		queues = append(queues, map[string]any{
			"name":        fmt.Sprintf("queue-%02d", index),
			"durable":     index%2 == 0,
			"auto_delete": index%3 == 0,
			"state":       "running",
			"messages":    index * 100,
			"consumers":   index % 4,
		})
	}
	body, err := json.Marshal(map[string]any{
		"items":       queues,
		"page":        1,
		"page_count":  1,
		"total_count": len(queues),
	})
	if err != nil {
		panic(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(body)
	})}
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			panic(err)
		}
	}()
	return "http://" + listener.Addr().String(), func() {
		_ = server.Close()
	}
}

func javaAgentCommand(jarPath string) []string {
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
		"--add-opens=java.sql/java.sql=ALL-UNNAMED",
		"-XX:TieredStopAtLevel=1",
		"-XX:+UseSerialGC",
		"-jar",
		jarPath,
	}
}

func sanitizedEnv() []string {
	blocked := map[string]struct{}{
		"HTTP_PROXY": {}, "HTTPS_PROXY": {}, "ALL_PROXY": {}, "NO_PROXY": {},
		"http_proxy": {}, "https_proxy": {}, "all_proxy": {}, "no_proxy": {},
	}
	result := make([]string, 0, len(os.Environ()))
	for _, variable := range os.Environ() {
		key, _, _ := strings.Cut(variable, "=")
		if _, skip := blocked[key]; !skip {
			result = append(result, variable)
		}
	}
	return result
}

func percentile(sorted []float64, ratio float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	index := int(math.Ceil(ratio*float64(len(sorted)))) - 1
	if index < 0 {
		index = 0
	}
	return sorted[index]
}

func medianInt64(values []int64) int64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]int64(nil), values...)
	sort.Slice(sorted, func(left, right int) bool { return sorted[left] < sorted[right] })
	return sorted[len(sorted)/2]
}

func readRSSKB(processID int) int64 {
	output, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(processID)).Output()
	if err != nil {
		return 0
	}
	value, err := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0
	}
	return value
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		panic(err)
	}
	return info.Size()
}

func milliseconds(duration time.Duration) float64 {
	return float64(duration.Nanoseconds()) / float64(time.Millisecond)
}

func requiredEnv(key string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		panic(key + " is required")
	}
	return value
}

func envInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 {
		panic(key + " must be a positive integer")
	}
	return parsed
}

func encode(encoder *json.Encoder, value any) {
	if err := encoder.Encode(value); err != nil {
		panic(err)
	}
}
