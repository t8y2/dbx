package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strconv"
	"strings"
	"time"

	go_ora "github.com/sijms/go-ora/v2"
)

type legacyJobPrepareRequest struct {
	OperationID string `json:"operationId"`
	What        string `json:"what"`
	NextDate    string `json:"nextDate"`
	Interval    string `json:"interval"`
	Enabled     bool   `json:"enabled"`
	Instance    int64  `json:"instance"`
	Schema      string `json:"schema"`
	TimeoutSecs int    `json:"timeoutSecs"`
}

type legacyJobResult struct {
	OperationID string `json:"operationId"`
	JobID       string `json:"jobId,omitempty"`
	Phase       string `json:"phase"`
	Reason      string `json:"reason,omitempty"`
	VendorCode  *int   `json:"vendorCode,omitempty"`
}

// This is separate from the editor transaction and stays on one physical connection.
type legacyJobSession struct {
	request legacyJobPrepareRequest
	result  legacyJobResult
	conn    *sql.Conn
	tx      *sql.Tx
}

func legacyJobNumericID(id string) bool {
	if id == "" || id[0] == '0' {
		return false
	}
	for _, b := range []byte(id) {
		if b < '0' || b > '9' {
			return false
		}
	}
	return true
}

func (job *legacyJobSession) discardConnection() {
	if job.conn != nil {
		// Raw's ErrBadConn discards this connection; it does not replay a statement.
		_ = job.conn.Raw(func(any) error { return driver.ErrBadConn })
		_ = job.conn.Close()
		job.conn = nil
	}
}

func (job *legacyJobSession) rollback(reason string, cause error) legacyJobResult {
	job.result.Reason = reason
	job.result.VendorCode = oracleVendorCode(cause)
	if job.tx == nil {
		job.discardConnection()
		return job.result
	}
	err := job.tx.Rollback()
	job.tx = nil
	if err == nil {
		job.result.Phase = "rolled_back"
	} else {
		job.result.Phase = "unknown"
		job.result.Reason = "native_job_rollback_unknown"
		if code := oracleVendorCode(err); code != nil {
			job.result.VendorCode = code
		}
	}
	job.discardConnection()
	return job.result
}

func (s *server) prepareLegacyJob(request legacyJobPrepareRequest) legacyJobResult {
	if s.legacyJob != nil {
		if s.legacyJob.request != request {
			return legacyJobResult{OperationID: request.OperationID, Phase: "unknown", Reason: "native_job_operation_mismatch"}
		}
		return s.legacyJob.result
	}
	invalid := func(reason string) legacyJobResult {
		return legacyJobResult{OperationID: request.OperationID, Phase: "not_started", Reason: reason}
	}
	if request.OperationID == "" || len(request.OperationID) > 128 || strings.ContainsRune(request.OperationID, '\x00') || request.Instance < 0 || request.TimeoutSecs < 0 || strings.ContainsRune(request.Schema, '\x00') {
		return invalid("native_job_request_invalid")
	}
	if _, err := time.Parse("2006-01-02 15:04:05", request.NextDate); err != nil {
		return invalid("native_job_date_invalid")
	}
	if strings.TrimSpace(request.What) == "" {
		return invalid("native_job_action_required")
	}
	db, err := s.requireDB()
	if err != nil {
		return invalid("native_job_connection_missing")
	}
	job := &legacyJobSession{request: request, result: legacyJobResult{OperationID: request.OperationID, Phase: "not_started"}}
	s.legacyJob = job
	ctx := context.Background()
	var cancel context.CancelFunc
	if request.TimeoutSecs > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(request.TimeoutSecs)*time.Second)
		defer cancel()
	}
	job.conn, err = db.Conn(ctx)
	if err != nil {
		job.result.Reason = "native_job_session_open_failed"
		job.result.VendorCode = oracleVendorCode(err)
		return job.result
	}
	if request.Schema != "" {
		if _, err = job.conn.ExecContext(ctx, "ALTER SESSION SET CURRENT_SCHEMA = "+quoteIdentifier(request.Schema)); err != nil {
			job.result.Reason = "native_job_schema_not_selected"
			job.result.VendorCode = oracleVendorCode(err)
			job.discardConnection()
			return job.result
		}
	}
	// A statement deadline must not become the transaction lifetime: preparation
	// returns before Core records the OUT ID and authorizes the first commit.
	job.tx, err = job.conn.BeginTx(context.Background(), nil)
	if err != nil {
		job.result.Reason = "native_job_transaction_not_started"
		job.result.VendorCode = oracleVendorCode(err)
		job.discardConnection()
		return job.result
	}
	job.result.Phase = "submitting"
	var id string
	var out any = go_ora.Out{Dest: &id, Size: 64}
	if usesOCIProfile(s.params) {
		out = sql.Out{Dest: &id}
	}
	_, err = job.tx.ExecContext(ctx, `DECLARE native_id BINARY_INTEGER;
BEGIN
  SYS.DBMS_JOB.SUBMIT(job => native_id, what => :what, next_date => TO_DATE(:next_date, 'YYYY-MM-DD HH24:MI:SS'), interval => :repeat_interval, no_parse => FALSE, instance => :instance, force => FALSE);
  :job_id := TO_CHAR(native_id);
END;`, sql.Named("what", request.What), sql.Named("next_date", request.NextDate), sql.Named("repeat_interval", request.Interval), sql.Named("instance", request.Instance), sql.Named("job_id", out))
	if legacyJobNumericID(id) {
		job.result.JobID = id
	}
	if err != nil {
		return job.rollback("native_job_submit_failed", err)
	}
	if job.result.JobID == "" {
		return job.rollback("native_job_out_id_unverified", nil)
	}
	broken := 0
	if !request.Enabled {
		broken = 1
	}
	job.result.Phase = "configuring"
	_, err = job.tx.ExecContext(ctx, `BEGIN SYS.DBMS_JOB.BROKEN(TO_NUMBER(:job_id), :broken = 1, TO_DATE(:next_date, 'YYYY-MM-DD HH24:MI:SS')); END;`, sql.Named("job_id", id), sql.Named("broken", broken), sql.Named("next_date", request.NextDate))
	if err != nil {
		return job.rollback("native_job_initial_state_failed", err)
	}
	var gotID, what, nextDate, brokenFlag, instance, logUser, privUser, schemaUser string
	var interval sql.NullString
	err = job.tx.QueryRowContext(ctx, `SELECT TO_CHAR(JOB), WHAT, TO_CHAR(NEXT_DATE, 'YYYY-MM-DD HH24:MI:SS'), INTERVAL, BROKEN, TO_CHAR(INSTANCE), LOG_USER, PRIV_USER, SCHEMA_USER FROM SYS.USER_JOBS WHERE JOB = TO_NUMBER(:job_id)`, sql.Named("job_id", id)).Scan(&gotID, &what, &nextDate, &interval, &brokenFlag, &instance, &logUser, &privUser, &schemaUser)
	if err != nil {
		return job.rollback("native_job_initial_read_failed", err)
	}
	expectedBroken := "N"
	if !request.Enabled {
		expectedBroken = "Y"
	}
	if gotID != id || what != request.What || nextDate != request.NextDate || interval.String != request.Interval || brokenFlag != expectedBroken || instance != strconv.FormatInt(request.Instance, 10) || (request.Schema != "" && schemaUser != request.Schema) {
		return job.rollback("native_job_initial_state_unverified", nil)
	}
	job.result.Phase = "prepared"
	return job.result
}

func (s *server) finishLegacyJob(operationID, jobID string, commit bool) legacyJobResult {
	job := s.legacyJob
	if job == nil || job.result.OperationID != operationID {
		return legacyJobResult{OperationID: operationID, Phase: "unknown", Reason: "native_job_session_unavailable"}
	}
	if job.result.Phase != "prepared" {
		return job.result
	}
	if (commit || jobID != "") && (jobID != job.result.JobID || !legacyJobNumericID(jobID)) {
		return legacyJobResult{OperationID: operationID, Phase: "unknown", Reason: "native_job_identity_mismatch"}
	}
	if !commit {
		return job.rollback("native_job_canceled_before_commit", nil)
	}
	job.result.Phase = "commit_sent"
	err := job.tx.Commit()
	job.tx = nil
	if err != nil {
		job.result.Phase = "unknown"
		job.result.Reason = "native_job_commit_unknown"
		job.result.VendorCode = oracleVendorCode(err)
	} else {
		job.result.Phase = "committed"
	}
	job.discardConnection()
	return job.result
}

func (s *server) legacyJobStatus(operationID string) legacyJobResult {
	if s.legacyJob == nil || s.legacyJob.result.OperationID != operationID {
		return legacyJobResult{OperationID: operationID, Phase: "unknown", Reason: "native_job_session_unavailable"}
	}
	return s.legacyJob.result
}

func (s *server) closeLegacyJob() error {
	if s.legacyJob != nil && s.legacyJob.tx != nil {
		result := s.legacyJob.rollback("native_job_session_closed_before_commit", nil)
		if result.Phase != "rolled_back" {
			return errors.New("native_job_rollback_unknown")
		}
	}
	return nil
}
