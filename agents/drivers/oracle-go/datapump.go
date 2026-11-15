package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"strconv"
	"strings"
	"sync"
	"time"
)

// datapumpEntry 是一个 Data Pump 任务的全部状态（每会话同时只允许一个任务，
// 对齐 legacyJob 的单任务约束）。
//
// 并发模型（本文件最重要的一句话）：startDatapump 返回之后，pinned 连接
// （conn）的唯一使用者是 poll 这个后台 goroutine——RPC 处理函数只在 mu 锁
// 保护下"读快照、改标志位"，从不直接碰连接。这样 *sql.Conn 的
// "不许并发使用"规则天然满足，不需要连接级大锁。
type datapumpEntry struct {
	mu         sync.Mutex
	request    datapumpStartRequest
	jobName    string
	logFile    string
	state      string // running | succeeded | failed | cancelled | lease_expired
	reason     string
	vendorCode *int
	conn       *sql.Conn // 独占连接：DBMS_DATAPUMP 句柄和会话绑定
	handle     float64  // 数据泵任务句柄（OPEN 返回的那个数）
	snapshot   *datapumpStatusValues
	startedAt  time.Time
	// leaseDeadline 由每次 status RPC 续期；轮询循环每次迭代检查，
	// 过期就自动 STOP_JOB（防止宿主崩溃后任务变孤儿）。
	leaseDeadline time.Time
	stopRequested bool // 取消标志：stop RPC 只改它，由轮询循环去执行 STOP_JOB
	// finishedAt 记录进入终态的时刻。清理只删"终态且超过保留期"的 entry——
	// 否则刚完成的任务会被新一轮 start 的清理删掉，前端轮询拿到
	// session_unavailable（任务其实已成功）。
	finishedAt time.Time
	pollCancel context.CancelFunc
	done          chan struct{} // 轮询循环退出的信号（channel ≈ 单元素 BlockingQueue）
}

// 用包级 var 而不是 const，是为了测试可覆盖：
// 测试里把租约改成 50ms、轮询等待改成 0，不用真等 120 秒。
var (
	datapumpLeaseDuration = 120 * time.Second
	// GET_STATUS 的 timeout 绑定为 0：立即返回当前状态。非零值会在
	// "状态无变化"时返回空 status 对象（percent 恒为 NULL，界面卡 0%）。
	datapumpStatusTimeoutSec = 0
	// 轮询节奏：服务器端不再等待，由这里的 sleep 控制频率。
	datapumpIdlePollDelay = 750 * time.Millisecond
)

// oracle_datapump_start 的返回结构。
type datapumpStartResult struct {
	OperationID string            `json:"operationId"`
	JobName     string            `json:"jobName,omitempty"`
	State       string            `json:"state"`
	Reason      string            `json:"reason,omitempty"`
	VendorCode  *int              `json:"vendorCode,omitempty"`
	Context     map[string]string `json:"context,omitempty"` // 预检失败的上下文（哪个目录、缺什么角色）
}

// oracle_datapump_status 的返回结构。
type datapumpStatusResult struct {
	OperationID string  `json:"operationId"`
	State       string  `json:"state"`
	Reason      string  `json:"reason,omitempty"`
	VendorCode  *int    `json:"vendorCode,omitempty"`
	JobName     string  `json:"jobName,omitempty"`
	JobState    string  `json:"jobState,omitempty"`
	Percent     float64 `json:"percent"`
	PhaseCode   float64 `json:"phaseCode"`
	ErrorText   string  `json:"errorText,omitempty"`
	ErrorCount  float64 `json:"errorCount"`
	ElapsedMs   int64   `json:"elapsedMs"`
}

// terminalLocked 判断是否处于终态。名字带 Locked 后缀 = 调用方必须已持有
// mu 锁（本代码库的命名约定，防止忘锁）。
func (e *datapumpEntry) terminalLocked() bool {
	switch e.state {
	case "succeeded", "failed", "cancelled", "lease_expired":
		return true
	default:
		return false
	}
}

// statusLocked 在锁内把当前状态拍成快照返回。
func (e *datapumpEntry) statusLocked() datapumpStatusResult {
	result := datapumpStatusResult{
		OperationID: e.request.OperationID,
		State:       e.state,
		Reason:      e.reason,
		VendorCode:  e.vendorCode,
		JobName:     e.jobName,
		ElapsedMs:   time.Since(e.startedAt).Milliseconds(),
	}
	if e.snapshot != nil {
		result.JobState = e.snapshot.JobState
		result.Percent = e.snapshot.Percent
		result.PhaseCode = e.snapshot.PhaseCode
		result.ErrorText = e.snapshot.ErrorText
		result.ErrorCount = e.snapshot.ErrorCount
	}
	return result
}

// startDatapump：校验 → 预检 → OPEN 启动块 → 拉起轮询 goroutine。
// 幂等：同一个 operationId 重试返回当前状态，不会开出第二个任务。
func (s *server) startDatapump(request datapumpStartRequest) datapumpStartResult {
	if reason, field := request.validate(); reason != "" {
		return datapumpStartResult{OperationID: request.OperationID, State: "failed", Reason: reason, Context: map[string]string{"field": field}}
	}
	// 幂等：同一 operationId 重试返回当前状态。
	if existing, ok := s.datapumps[request.OperationID]; ok {
		existing.mu.Lock()
		defer existing.mu.Unlock()
		return datapumpStartResult{OperationID: request.OperationID, JobName: existing.jobName, State: existing.state, Reason: existing.reason, VendorCode: existing.vendorCode}
	}
	// 惰性清理：只删"已终态且超过保留期"的 entry。刚完成的任务必须保留，
	// 否则前端还在轮询旧任务时会拿到 session_unavailable（任务其实成功了）。
	for id, e := range s.datapumps {
		e.mu.Lock()
		expired := e.terminalLocked() && !e.finishedAt.IsZero() && time.Since(e.finishedAt) > datapumpEntryRetention
		e.mu.Unlock()
		if expired {
			delete(s.datapumps, id)
		}
	}
	db, err := s.requireDB()
	if err != nil {
		return datapumpStartResult{OperationID: request.OperationID, State: "failed", Reason: "datapump_connection_missing"}
	}
	conn, err := db.Conn(context.Background()) // 从连接池借出一条独占连接
	if err != nil {
		return datapumpStartResult{OperationID: request.OperationID, State: "failed", Reason: "datapump_session_open_failed"}
	}
	entry := &datapumpEntry{
		request:       request,
		state:         "running",
		conn:          conn,
		startedAt:     time.Now(),
		leaseDeadline: time.Now().Add(datapumpLeaseDuration),
		done:          make(chan struct{}),
	}
	// fail 闭包：统一的失败出口——丢弃连接 + 带上原因码、ORA 码和数据库原文返回。
	// 错误原文必须透传（精准报错三要素），否则排障只能靠猜。
	fail := func(reason string, cause error, ctx map[string]string) datapumpStartResult {
		entry.discardConnection()
		if cause != nil && ctx != nil {
			if text := strings.TrimSpace(cause.Error()); text != "" {
				context := map[string]string{}
				for key, value := range ctx {
					context[key] = value
				}
				context["error"] = text
				ctx = context
			}
		}
		return datapumpStartResult{OperationID: request.OperationID, State: "failed", Reason: reason, VendorCode: oracleVendorCode(cause), Context: ctx}
	}
	if reason, ctx := s.datapumpPreflight(conn, request); reason != "" {
		return fail(reason, nil, ctx)
	}
	entry.jobName = datapumpJobName(request)
	entry.logFile = request.LogFile
	if entry.logFile == "" {
		entry.logFile = defaultDatapumpLogFile(request.DumpFile)
	}
	script := buildDatapumpOpenScript(request, entry.logFile)
	if _, err = conn.ExecContext(context.Background(), script.SQL, script.bindArgs(&entry.handle, usesOCIProfile(s.params))...); err != nil {
		// 带上 ADD_FILE 的三个实际输入（文件名/目录名），ORA-39001 这类
		// "参数值非法"必须看到值本身才能定位。
		return fail("datapump_start_failed", err, map[string]string{
			"jobName":   entry.jobName,
			"directory": request.Directory,
			"dumpfile":  request.DumpFile,
			"logfile":   entry.logFile,
		})
	}
	pollCtx, cancel := context.WithCancel(context.Background())
	entry.pollCancel = cancel
	s.datapumps[request.OperationID] = entry
	// go 关键字：把 poll 丢进一个新 goroutine 跑（≈ 提交线程任务但不等），
	// 当前函数立刻往下走并返回。
	go entry.poll(pollCtx, usesOCIProfile(s.params))
	return datapumpStartResult{OperationID: request.OperationID, JobName: entry.jobName, State: entry.state}
}

// datapumpPreflight 跑方案 §3.2.1 的预检（在独占连接上），
// 返回精确原因码 + 上下文值（宿主用它渲染可操作的报错文案）。
func (s *server) datapumpPreflight(conn *sql.Conn, request datapumpStartRequest) (string, map[string]string) {
	var sessionUser string
	if err := conn.QueryRowContext(context.Background(), datapumpPreflightUserSQL).Scan(&sessionUser); err != nil {
		return "datapump_preflight_user_unavailable", nil
	}
	var version string
	if err := conn.QueryRowContext(context.Background(), datapumpPreflightVersionSQL).Scan(&version); err != nil {
		return "datapump_preflight_version_unavailable", nil
	}
	if major, err := strconv.Atoi(strings.SplitN(version, ".", 2)[0]); err != nil || major < 11 {
		return "datapump_preflight_version_unsupported", map[string]string{"version": version}
	}
	var dirPath string
	err := conn.QueryRowContext(context.Background(), datapumpPreflightDirectorySQL, sql.Named("directory", request.Directory)).Scan(&dirPath)
	if err == sql.ErrNoRows { // ≈ JDBC 的空 ResultSet：目录对象不存在
		return "datapump_preflight_directory_missing", map[string]string{"directory": request.Directory}
	}
	if err != nil {
		return "datapump_preflight_directory_unavailable", map[string]string{"directory": request.Directory}
	}
	// 写探针对所有连接生效（SYSDBA 也不例外）：路径不可写时 ADD_FILE
	// 只会抛误导性的 ORA-39001，这里直接给出真正原因。
	if _, err := conn.ExecContext(context.Background(), datapumpPreflightProbeWriteSQL, sql.Named("directory", request.Directory)); err != nil {
		return "datapump_preflight_directory_not_writable", map[string]string{
			"directory": request.Directory,
			"path":      dirPath,
			"error":     strings.TrimSpace(err.Error()),
		}
	}
	// SYSDBA 连接的权限来自口令文件身份而非授权表（数据字典里不存在
	// "GRANT ... TO SYS"），执行层又绕过所有权限检查——权限类检查直接
	// 放行，否则必然误判。普通连接才做目录权限与跨 schema 角色检查。
	if s.params.SysDBA {
		return "", nil
	}
	var privCount int
	if err = conn.QueryRowContext(context.Background(), datapumpPreflightDirectoryPrivSQL, sql.Named("directory", request.Directory)).Scan(&privCount); err != nil {
		return "datapump_preflight_directory_unavailable", map[string]string{"directory": request.Directory}
	}
	if privCount < 2 { // 必须同时有 READ 和 WRITE（含直接授予、PUBLIC、经角色）
		return "datapump_preflight_directory_no_privilege", map[string]string{"directory": request.Directory, "path": dirPath, "user": sessionUser}
	}
	// 跨 schema（导/导入别人的模式）需要对应的 full 角色；
	// table 模式靠普通对象权限，不做这个检查。
	if request.Mode == datapumpModeSchema && !s.datapumpSchemasAllOwn(conn, request, sessionUser) {
		return "datapump_preflight_cross_schema_denied", map[string]string{"user": sessionUser, "role": datapumpNeededRole(request.Kind)}
	}
	return "", nil
}

func datapumpNeededRole(kind string) string {
	if kind == datapumpKindImport {
		return "IMP_FULL_DATABASE"
	}
	return "EXP_FULL_DATABASE"
}

// datapumpSchemasAllOwn 报告：请求的 schema 是否全归当前用户所有；
// 不是的话查有没有按操作类型对应的 full 角色。
func (s *server) datapumpSchemasAllOwn(conn *sql.Conn, request datapumpStartRequest, sessionUser string) bool {
	needed := false
	for _, schema := range request.Schemas {
		if !strings.EqualFold(schema, sessionUser) { // EqualFold ≈ equalsIgnoreCase
			needed = true
			break
		}
	}
	if !needed {
		return true
	}
	roleSQL := datapumpPreflightExportRoleSQL
	if request.Kind == datapumpKindImport {
		roleSQL = datapumpPreflightImportRoleSQL
	}
	var roleCount int
	if err := conn.QueryRowContext(context.Background(), roleSQL).Scan(&roleCount); err != nil || roleCount == 0 {
		return false
	}
	return true
}

// poll 是整个引擎的心脏（轮询循环，pinned 连接的唯一使用者）。
// 每轮：查停止标志 → 查租约 → 跑一次 GET_STATUS（服务器端最多阻塞 N 秒
// 等状态变化，天然充当轮询等待）。终态处理：COMPLETED → 成功；
// COMPLETED WITH ERRORS → 失败；STOPPED → 被取消。
func (e *datapumpEntry) poll(ctx context.Context, oci bool) {
	defer close(e.done) // defer ≈ try-finally：退出时关闭 done 通道，通知所有等待者
	script, bindArgs := buildDatapumpStatusScript(datapumpStatusTimeoutSec)
	for {
		e.mu.Lock()
		if e.stopRequested {
			e.mu.Unlock()
			e.stopJob(ctx, oci, "cancelled", "datapump_canceled")
			return
		}
		if time.Now().After(e.leaseDeadline) && !e.terminalLocked() {
			e.mu.Unlock()
			e.stopJob(ctx, oci, "lease_expired", "datapump_lease_expired")
			return
		}
		conn, handle, terminal := e.conn, e.handle, e.terminalLocked()
		e.mu.Unlock() // 锁只护状态读写；耗时的数据库调用必须放锁外
		if terminal {
			return
		}
		values := &datapumpStatusValues{}
		_, err := conn.ExecContext(ctx, script, bindArgs(values, handle, oci)...)
		time.Sleep(datapumpPollDelay())
		if err != nil {
			// ctx 被取消 = 关闭流程要求退出，连接可能已废，直接丢弃不尝试收尾。
			if ctx.Err() != nil {
				e.finish("failed", "datapump_session_closed", nil, oci, false)
				return
			}
			reason := "datapump_status_failed"
			if code := oracleVendorCode(err); code != nil && *code == 31626 {
				// ORA-31626（句柄失效）最常见的原因是任务正常完成：Data Pump
				// 完成时会自删 master table，句柄随之失效。查任务表区分
				// "干净完成并自清理"（行已消失）与"真丢了"（行还在）。
				if e.finishedJobState(ctx) == "" {
					e.finish("succeeded", "", nil, oci, false)
					return
				}
				reason = "datapump_job_lost" // 行还在：任务被外部干预或异常残留
			}
			e.finish("failed", reason, err, oci, false)
			return
		}
		if terminalState, reason := datapumpTerminalState(values.JobState); terminalState != "" {
			// COMPLETED 但有错误 → 升级为 failed（GET_STATUS 的 job_state
			// 有时只报 "COMPLETED"，错误只体现在 error 列表里）。
			if terminalState == "succeeded" && values.ErrorCount > 0 {
				terminalState = "failed"
				reason = "datapump_completed_with_errors"
			}
			e.mu.Lock()
			e.snapshot = values
			e.mu.Unlock()
			if terminalState == "failed" && reason == "" {
				reason = "datapump_completed_with_errors"
			}
			e.finish(terminalState, reason, nil, oci, true) // detach=true：正常收尾要脱离
			return
		}
		e.mu.Lock()
		e.snapshot = values // 更新快照给 status RPC 读
		e.mu.Unlock()
	}
}

// datapumpPollDelay 返回本轮 sleep：生产 750ms；测试可覆盖成毫秒级。
func datapumpPollDelay() time.Duration { return datapumpIdlePollDelay }

// finishedJobState 查询本任务的最终状态：返回 "" 表示任务行已消失
// （干净完成、master table 已自删）；查得到则返回状态文本（如 NOT RUNNING）。
func (e *datapumpEntry) finishedJobState(ctx context.Context) string {
	e.mu.Lock()
	conn, job := e.conn, e.jobName
	e.mu.Unlock()
	if conn == nil || job == "" {
		return "unknown"
	}
	var state string
	err := conn.QueryRowContext(ctx,
		"SELECT STATE FROM SYS.USER_DATAPUMP_JOBS WHERE JOB_NAME = UPPER(:job)",
		sql.Named("job", job)).Scan(&state)
	if err == sql.ErrNoRows {
		return ""
	}
	if err != nil {
		return "unknown"
	}
	return state
}

// datapumpTerminalState 把 job_state 映射成引擎状态（空 = 还在跑）。
func datapumpTerminalState(jobState string) (state, reason string) {
	switch jobState {
	case "COMPLETED":
		return "succeeded", ""
	case "COMPLETED WITH ERRORS":
		return "failed", "datapump_completed_with_errors"
	case "STOPPED":
		return "cancelled", "datapump_stopped_externally" // DBA 手动停的
	default:
		return "", ""
	}
}

// stopJob 执行 STOP_JOB 并收尾。ORA-31626（任务已不在）视为正常——
// "用户取消"和"任务刚好自己完成"赛跑是常态，不能报错。
func (e *datapumpEntry) stopJob(ctx context.Context, oci bool, state, reason string) {
	e.mu.Lock()
	conn, handle := e.conn, e.handle
	e.mu.Unlock()
	if conn == nil {
		e.finish(state, reason, nil, oci, false)
		return
	}
	if _, err := conn.ExecContext(ctx, datapumpStopScript, sql.Named("handle", handle)); err != nil {
		if code := oracleVendorCode(err); code == nil || *code != 31626 {
			e.finish(state, reason, err, oci, false)
			return
		}
	}
	e.finish(state, reason, nil, oci, false)
}

// finish 是统一收尾：记录终态 → （可选）DETACH → 关闭 pinned 连接。
// 已处于终态则什么都不做（防二次收尾）。
func (e *datapumpEntry) finish(state, reason string, cause error, oci, detach bool) {
	e.mu.Lock()
	if e.terminalLocked() {
		e.mu.Unlock()
		return
	}
	e.state, e.reason = state, reason
	e.finishedAt = time.Now()
	e.vendorCode = oracleVendorCode(cause)
	conn, handle := e.conn, e.handle
	e.conn = nil
	e.mu.Unlock()
	if conn == nil {
		return
	}
	if detach && handle != 0 {
		_, _ = conn.ExecContext(context.Background(), datapumpDetachScript, sql.Named("handle", handle))
	}
	_ = conn.Close()
}

// discardConnection 不做任何服务器调用直接扔掉连接（启动失败路径用），
// 对齐 legacyJobSession.discardConnection 的做法。
func (e *datapumpEntry) discardConnection() {
	e.mu.Lock()
	conn := e.conn
	e.conn = nil
	e.mu.Unlock()
	if conn != nil {
		_ = conn.Raw(func(any) error { return driver.ErrBadConn }) // 标记连接不可复用
		_ = conn.Close()
	}
}

// datapumpStatusResultFor 是 status RPC 的实现：续租 + 返回快照。
func (s *server) datapumpStatusResultFor(operationID string) datapumpStatusResult {
	entry, ok := s.datapumps[operationID]
	if !ok {
		return datapumpStatusResult{OperationID: operationID, State: "failed", Reason: "datapump_session_unavailable"}
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if !entry.terminalLocked() {
		entry.leaseDeadline = time.Now().Add(datapumpLeaseDuration)
	}
	return entry.statusLocked()
}

// stopDatapump 是 stop RPC 的实现：只翻标志位 + 等轮询循环干完活。
func (s *server) stopDatapump(operationID string) datapumpStatusResult {
	entry, ok := s.datapumps[operationID]
	if !ok {
		return datapumpStatusResult{OperationID: operationID, State: "failed", Reason: "datapump_session_unavailable"}
	}
	entry.mu.Lock()
	if !entry.terminalLocked() {
		entry.stopRequested = true
	}
	result := entry.statusLocked()
	entry.mu.Unlock()
	if result.State == "cancelled" {
		return result
	}
	// select ≈ "谁先 ready 走谁"：等轮询退出，最多等 datapumpStopWait
	// （最坏情况 = 一次 GET_STATUS 的阻塞时长）。
	select {
	case <-entry.done:
	case <-time.After(datapumpStopWait):
	}
	return s.datapumpStatusResultFor(operationID)
}

// datapumpEntryRetention 是终态 entry 的保留时长：足够前端把最后几次轮询
// 读完、用户回看结果，又不会让 map 无限增长。
const datapumpEntryRetention = 10 * time.Minute

// datapumpStopWait 限定 stop RPC 等待轮询循环完成 STOP_JOB 的最长时间。
var datapumpStopWait = 10 * time.Second

// closeDatapump 是会话关闭路径：停掉在途任务 → 等轮询退出（超时强杀）→ 清掉 entry。
func (s *server) closeDatapump() {
	for _, entry := range s.datapumps {
		entry.mu.Lock()
		stopped := entry.terminalLocked()
		if !stopped {
			entry.stopRequested = true
		}
		entry.mu.Unlock()
		if !stopped {
			select {
			case <-entry.done:
			case <-time.After(datapumpStopWait): // 软等超时 → 取消 ctx 掐断阻塞中的 GET_STATUS
				if entry.pollCancel != nil {
					entry.pollCancel()
				}
				select {
				case <-entry.done:
				case <-time.After(2 * time.Second):
				}
			}
		}
	}
	s.datapumps = make(map[string]*datapumpEntry)
}
