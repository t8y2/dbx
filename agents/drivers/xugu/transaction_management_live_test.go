package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"regexp"
	"testing"
	"time"
)

// TestLiveXuguTransactionManagement verifies the SQL used by the desktop
// transaction panel against a real XuguDB instance. The only killed target is
// a transaction opened by this test; no application transaction is touched.
func TestLiveXuguTransactionManagement(t *testing.T) {
	if os.Getenv("XUGU_LIVE_TEST") != "1" {
		t.Skip("set XUGU_LIVE_TEST=1 with XUGU_LIVE_* connection settings")
	}
	params := liveXuguParams(t)
	params.Database = "SYSTEM"
	admin, err := openDB(params)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var ownNode, ownSession int64
	if err := admin.QueryRowContext(ctx, "SELECT NODEID, SESSION_ID FROM SYS_SESSIONS WHERE SESSION_ID = USERENV('SID')").Scan(&ownNode, &ownSession); err != nil {
		t.Fatalf("own-session SQL: %v", err)
	}
	if ownNode <= 0 || ownSession < 0 {
		t.Fatalf("invalid own-session identity: node=%d session=%d", ownNode, ownSession)
	}

	const listSQL = `SELECT T.NODEID AS NODE_ID,
       CAST(T.TRANID AS VARCHAR(32)) AS TRANSACTION_ID,
       S.SESSION_ID AS SESSION_ID,
       S.USER_NAME AS USER_NAME,
       S.DB_NAME AS DB_NAME,
       S.IP AS CLIENT_IP,
       T.START_T AS START_TIME
FROM SYS_ALL_TRANS T
JOIN SYS_ALL_SESSIONS S
  ON T.NODEID = S.NODEID AND T.TRANID = S.CURR_TID
ORDER BY T.START_T`
	rows, err := admin.QueryContext(ctx, listSQL)
	if err != nil {
		t.Fatalf("transaction-list SQL: %v", err)
	}
	if err := rows.Close(); err != nil {
		t.Fatal(err)
	}

	// Keep a dedicated second connection in one explicit transaction so the
	// administrative session can only terminate this test-owned transaction.
	worker, err := openDB(params)
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	conn, err := worker.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var targetNode, targetSession int64
	var targetTransaction string
	if err := tx.QueryRowContext(ctx, "SELECT NODEID, SESSION_ID, CAST(CURR_TID AS VARCHAR(32)) FROM SYS_SESSIONS WHERE SESSION_ID = USERENV('SID')").Scan(&targetNode, &targetSession, &targetTransaction); err != nil {
		t.Fatalf("test-owned transaction identity: %v", err)
	}
	if targetNode <= 0 || targetSession < 0 || targetTransaction == "" || targetTransaction == "0" || (targetNode == ownNode && targetSession == ownSession) {
		t.Fatalf("unsafe test target: node=%d session=%d transaction=%q", targetNode, targetSession, targetTransaction)
	}

	var listed bool
	rows, err = admin.QueryContext(ctx, listSQL)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var node, session int64
		var transaction string
		var user, dbName, ip sql.NullString
		var start any
		if err := rows.Scan(&node, &transaction, &session, &user, &dbName, &ip, &start); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		if node == targetNode && session == targetSession && transaction == targetTransaction {
			listed = true
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	if !listed {
		t.Fatalf("test-owned transaction %s was not listed", targetTransaction)
	}
	if !regexp.MustCompile(`^[1-9][0-9]*$`).MatchString(targetTransaction) {
		t.Fatalf("invalid server transaction id %q", targetTransaction)
	}
	// Exercise the exact literal statement sent by the desktop panel.
	if _, err := admin.ExecContext(ctx, fmt.Sprintf("CALL DBMS_DBA.KILL_TRANS(%d, %s)", targetNode, targetTransaction)); err != nil {
		t.Fatalf("terminate test-owned transaction: %v", err)
	}
}
