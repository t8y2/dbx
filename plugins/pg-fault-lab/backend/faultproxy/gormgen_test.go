package faultproxy

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/example"
	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/example/query"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestRealGORMAndGeneratedTransactions(t *testing.T) {
	for _, workflow := range []struct {
		name  string
		place func(context.Context, *gorm.DB, int64, int64) error
	}{{"gorm", example.PlaceOrderGORM}, {"gorm-gen", example.PlaceOrder}} {
		t.Run(workflow.name, func(t *testing.T) { exerciseOrderWorkflow(t, workflow.place) })
	}
}

func exerciseOrderWorkflow(t *testing.T, place func(context.Context, *gorm.DB, int64, int64) error) {
	s, admin := integration(t)
	ctx := context.Background()
	if _, e := admin.Exec(ctx, "CREATE TABLE IF NOT EXISTS fault_gen_orders(id bigint PRIMARY KEY,status text NOT NULL,amount bigint NOT NULL)"); e != nil {
		t.Fatal(e)
	}
	if _, e := admin.Exec(ctx, "TRUNCATE fault_gen_orders"); e != nil {
		t.Fatal(e)
	}
	h, p, _ := net.SplitHostPort(s.Addr())
	db, e := gorm.Open(postgres.Open(fmt.Sprintf("host=%s port=%s user=dbx_fault_fixture dbname=postgres sslmode=disable application_name=lab_gen", h, p)), &gorm.Config{PrepareStmt: true, Logger: logger.Default.LogMode(logger.Silent)})
	if e != nil {
		t.Fatal(e)
	}
	pool, _ := db.DB()
	pool.SetMaxOpenConns(4)
	defer pool.Close()
	// Generated Create + typed Update execute and commit as an ordinary transaction.
	if e = place(ctx, db, 1, 125); e != nil {
		t.Fatal(e)
	}
	q := query.Use(db).LabOrder
	row, e := q.WithContext(ctx).Where(q.ID.Eq(1)).First()
	if e != nil || row.Status != "paid" || row.Amount != 125 {
		t.Fatal(row, e)
	}
	// The UPDATE is held before execution, then succeeds without changing app code.
	add(t, s, "execute", "pause", "UPDATE", "lab_gen", 1)
	done := make(chan error, 2)
	go func() { done <- place(ctx, db, 2, 250) }()
	barrier := waitPause(t, s, 1)[0]
	var n int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM fault_gen_orders WHERE id=2").Scan(&n); e != nil || n != 0 {
		t.Fatal("uncommitted order visible", n, e)
	}
	if e = s.Resume(barrier.ID, false); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	// A forced failure is returned to gorm-gen, and neither Create nor Update commits.
	add(t, s, "commit", "abort", "COMMIT", "lab_gen", 1)
	if e = place(ctx, db, 3, 375); e == nil {
		t.Fatal("generated transaction swallowed forced failure")
	}
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM fault_gen_orders WHERE id=3").Scan(&n); e != nil || n != 0 {
		t.Fatal("generated transaction partially committed", n, e)
	}
	// Separate pooled connections pause independently; one commits and one aborts.
	add(t, s, "execute", "pause", "INSERT", "lab_gen", 2)
	for _, id := range []int64{4, 5} {
		go func(id int64) { done <- place(ctx, db, id, id*125) }(id)
	}
	barriers := waitPause(t, s, 2)
	if barriers[0].ConnectionID == barriers[1].ConnectionID {
		t.Fatal("generated clients shared one live connection")
	}
	s.Resume(barriers[0].ID, false)
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	select {
	case e = <-done:
		t.Fatal("unrelated barrier resumed", e)
	case <-time.After(20 * time.Millisecond):
	}
	s.Resume(barriers[1].ID, true)
	if e = <-done; e == nil {
		t.Fatal("generated barrier abort reported success")
	}
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM fault_gen_orders WHERE id IN (4,5)").Scan(&n); e != nil || n != 1 {
		t.Fatal("concurrent generated transaction outcomes wrong", n, e)
	}
}
