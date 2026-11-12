#!/usr/bin/env python3
"""Own a fresh socket-only MySQL instance; never accept an existing DB endpoint."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


def run(argv, text=None, check=True):
    result = subprocess.run(argv, input=text, text=True, capture_output=True, timeout=120)
    if check and result.returncode:
        raise RuntimeError(f"{argv[0]} exited {result.returncode}: {result.stderr[-6000:]}")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mysql-home", required=True, type=Path)
    parser.add_argument("--probe", required=True, type=Path)
    parser.add_argument("--artifacts", required=True, type=Path)
    args = parser.parse_args()
    home = args.mysql_home.resolve()
    probe = args.probe.resolve()
    artifacts = args.artifacts.resolve()
    artifacts.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="dbx-binlog-live-", dir=artifacts))
    # Unix socket paths must remain short on macOS; this path is task-owned.
    socket_dir = Path(tempfile.mkdtemp(prefix="dbx12838-"))
    socket = socket_dir / "m.sock"
    data = root / "data"
    data.mkdir(mode=0o700)
    command = [str(home / "bin/mysql"), "--no-defaults", "--protocol=SOCKET",
               f"--socket={socket}", "--user=root", "--batch", "--raw", "--skip-column-names",
               "--default-character-set=utf8mb4", "--binary-mode"]

    def sql(text, check=True):
        return run(command, text, check)

    run([str(home / "bin/mysqld"), "--no-defaults", f"--basedir={home}",
         f"--datadir={data}", "--initialize-insecure", f"--log-error={root / 'initialize.log'}"])
    server_log = (root / "server.log").open("w")
    server = subprocess.Popen([
        str(home / "bin/mysqld"), "--no-defaults", f"--basedir={home}", f"--datadir={data}",
        f"--socket={socket}", "--skip-networking", "--mysqlx=OFF", "--server-id=12838",
        f"--pid-file={root / 'server.pid'}", f"--log-bin={data / 'binlog'}",
        "--binlog-format=ROW", "--binlog-row-image=FULL", "--binlog-row-metadata=FULL",
        "--binlog-checksum=CRC32", "--binlog-transaction-compression=OFF",
        "--innodb-buffer-pool-size=32M", "--innodb-log-file-size=16M",
        "--performance-schema=OFF", "--local-infile=OFF",
    ], stdout=server_log, stderr=subprocess.STDOUT)
    evidence = {"run_directory": str(root), "cases": []}
    try:
        for _ in range(150):
            if server.poll() is not None:
                raise RuntimeError((root / "server.log").read_text()[-6000:])
            if socket.exists() and sql("SELECT 1;", check=False).returncode == 0:
                break
            time.sleep(0.2)
        else:
            raise RuntimeError("owned MySQL failed readiness")
        version = sql("SELECT VERSION();").stdout.strip()
        if version != "8.0.27":
            raise RuntimeError(f"expected MySQL 8.0.27, got {version}")
        evidence["mysql_version"] = version
        # Capture schema BEFORE DML. No current metadata is supplied to generation.
        sql("""
CREATE DATABASE recovery_lab;
CREATE TABLE recovery_lab.items (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
 payload BLOB NULL,
 label VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
 amount DECIMAL(30,6) NULL,
 v_count INT NULL,
 v_tx_active INT NULL,
 doc JSON NULL,
 wall DATETIME(6) NULL,
 instant TIMESTAMP(6) NULL,
 duration TIME(6) NULL
) ENGINE=InnoDB;
SET SESSION sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO';
SET SESSION time_zone='+00:00';
INSERT INTO recovery_lab.items VALUES
 (0,X'ff00275c',CONVERT(X'e99baa' USING utf8mb4),123456789012345678901234.567890,NULL,1,
 CAST('{"big":18446744073709551615,"list":[true,null,1.25,"x"]}' AS JSON),
 '2026-10-20 12:34:56.123456','2026-10-20 12:34:56.123456','-838:59:58.999999'),
 (10,X'00','before',-12.340000,1,0,CAST('null' AS JSON),NULL,NULL,'24:00:00.000001');
""")
        ddl = sql("SHOW CREATE TABLE recovery_lab.items;").stdout
        (root / "historical-ddl.tsv").write_text(ddl)
        metadata = sql("""SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
COALESCE(CHARACTER_SET_NAME,''), COALESCE(CHARACTER_OCTET_LENGTH,0),
COALESCE(NUMERIC_PRECISION,0),COALESCE(NUMERIC_SCALE,0),COALESCE(DATETIME_PRECISION,0)
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA='recovery_lab' AND TABLE_NAME='items' ORDER BY ORDINAL_POSITION;""").stdout
        (root / "historical-columns.tsv").write_text(metadata)
        columns = []
        for line in metadata.splitlines():
            name, kind, column_type, nullable, charset, length, precision, scale, temporal_precision = line.split("\t")
            if kind == "bigint":
                wire, meta, value_kind = 8, [], {"type": "integer"}
            elif kind == "int":
                wire, meta, value_kind = 3, [], {"type": "integer"}
            elif kind == "blob":
                wire, meta, value_kind = 252, [2], {"type": "binary"}
            elif kind == "varchar":
                length = int(length)
                wire, meta = 15, [length & 255, length >> 8]
                value_kind = {"type": "text", "charset": charset}
            elif kind == "decimal":
                wire, meta = 246, [int(precision), int(scale)]
                value_kind = {"type": "decimal", "precision": int(precision), "scale": int(scale)}
            elif kind == "json":
                wire, meta, value_kind = 245, [4], {"type": "json"}
            elif kind in ("datetime", "timestamp", "time"):
                wire = {"datetime":18,"timestamp":17,"time":19}[kind]
                meta = [int(temporal_precision)]
                value_kind = {"type": "date_time" if kind == "datetime" else kind,
                              "precision": int(temporal_precision)}
            else:
                raise RuntimeError(f"test harness has no historical mapping for {kind}")
            columns.append({"name": name, "wire_type": wire, "wire_metadata": meta,
                            "unsigned": "unsigned" in column_type, "nullable": nullable == "YES",
                            "generated": False, "kind": value_kind})
        table = {"database": "recovery_lab", "table": "items", "engine": "InnoDB",
                 "no_triggers_or_foreign_keys": True, "primary_key": [0], "columns": columns}

        def state():
            # Tagged HEX distinguishes NULL from empty bytes and compares all fields.
            return sql("""SET SESSION time_zone='+00:00';
SELECT id,IF(payload IS NULL,'N',CONCAT('V',HEX(payload))),
IF(label IS NULL,'N',CONCAT('V',HEX(label))),
IF(amount IS NULL,'N',CONCAT('V',CAST(amount AS CHAR))),
IF(v_count IS NULL,'N',CONCAT('V',v_count)),
IF(v_tx_active IS NULL,'N',CONCAT('V',v_tx_active)),
IF(doc IS NULL,'N',CONCAT('V',HEX(CAST(doc AS CHAR)))),
IF(wall IS NULL,'N',CONCAT('V',wall)),
IF(instant IS NULL,'N',CONCAT('V',instant)),
IF(duration IS NULL,'N',CONCAT('V',duration))
FROM recovery_lab.items ORDER BY id;""").stdout

        baseline = state()
        sql("FLUSH BINARY LOGS;")
        filename = sql("SHOW MASTER STATUS;").stdout.split("\t")[0]
        sql("""
SET SESSION sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO';
SET SESSION time_zone='+00:00';
BEGIN;
DELETE FROM recovery_lab.items WHERE id=0;
UPDATE recovery_lab.items SET id=11,payload=X'ff',label='middle',amount=1.000001,
 doc=CAST('{"n":-9007199254740993}' AS JSON),wall='2000-02-29 00:00:00.000001',
 instant='2000-02-29 00:00:00.000001',duration='-00:00:00.000001' WHERE id=10;
UPDATE recovery_lab.items SET id=12,label='after',v_count=NULL WHERE id=11;
INSERT INTO recovery_lab.items VALUES(20,X'00ff','new',0.123456,9,1,NULL,NULL,NULL,NULL);
COMMIT;
BEGIN;
UPDATE recovery_lab.items SET payload=X'abcd',v_count=-7,v_tx_active=0 WHERE id=12;
COMMIT;
""")
        changed = state()
        assert changed != baseline
        sql("FLUSH BINARY LOGS;")
        source = data / filename
        imported = root / filename
        imported.write_bytes(source.read_bytes())
        listing = json.loads(run([str(probe), "transactions", str(imported)]).stdout)
        assert len(listing["transactions"]) == 2, listing
        starts = [tx["start_position"] for tx in listing["transactions"]]
        schema = {"version": 1, "binlog_sha256": hashlib.sha256(imported.read_bytes()).hexdigest(),
                  "valid_from": int(starts[0]), "valid_to": imported.stat().st_size,
                  "provenance": "isolated schema captured before DML; historical-ddl/columns.tsv in this run",
                  "historical": True, "tables": [table]}
        schema_path = root / "historical-schema.json"
        schema_path.write_text(json.dumps(schema, indent=2))
        listing_path = root / "transactions.json"
        listing_path.write_text(json.dumps(listing, indent=2))

        def script(selected):
            return run([str(probe), "recover", str(imported), str(schema_path), *selected]).stdout

        # First only reverse the latest tx to test its own atomic conflict guard.
        latest_script = script(starts[1:])
        sql("UPDATE recovery_lab.items SET v_count=444 WHERE id=12;")
        conflict_state = state()
        failed = sql(latest_script, check=False)
        assert failed.returncode != 0 and "post-image" in failed.stderr, failed.stderr
        assert state() == conflict_state, "conflict modified rows instead of rolling back"
        evidence["cases"].append("post-image conflict refuses and rolls back")
        # Test-only --force lets a SELECT observe the SAME SESSION after CALL's
        # expected error. Production artifacts still require stop-on-first-error.
        failed_session = run(command + ["--force"],
                             "SET SESSION time_zone='+05:30';\n" + script(starts[1:]) +
                             "\nSELECT CONCAT('zone=',@@session.time_zone);", check=False)
        assert "post-image" in failed_session.stderr, failed_session.stderr
        assert "zone=+05:30" in failed_session.stdout, failed_session.stdout
        assert state() == conflict_state
        evidence["cases"].append("same-session timezone restored after SQLEXCEPTION conflict")
        # Repair the TEST mutation only, then execute the full artifact in a fresh session.
        sql("UPDATE recovery_lab.items SET v_count=-7 WHERE id=12;")
        full_script = script(starts)
        (root / "recovery.sql").write_text(full_script)
        # An injected warning exercises the generated handler, without depending
        # on server/version-specific coercion to manufacture a warning.
        warning_script = full_script.replace("SET v_tx_active = TRUE;",
                                             "SET v_tx_active = TRUE;\n  SIGNAL SQLSTATE '01000' SET MESSAGE_TEXT='test warning';", 1)
        warning_state = state()
        warned = run(command + ["--force"],
                     "SET SESSION time_zone='-07:00';\n" + warning_script +
                     "\nSELECT CONCAT('zone=',@@session.time_zone);", check=False)
        assert "SQL warning during recovery" in warned.stderr, warned.stderr
        assert "zone=-07:00" in warned.stdout
        assert state() == warning_state
        evidence["cases"].append("injected SQLWARNING rolls back and restores timezone in same session")
        # Exercise helper timezone normalization/restoration with a non-UTC caller.
        output = sql("SET SESSION time_zone='+05:30';\n" + full_script + "\nSELECT @@session.time_zone;")
        assert output.stdout.strip() == "+05:30", "caller timezone was not restored"
        restored = state()
        assert restored == baseline, f"field comparison failed:\nBEFORE\n{baseline}\nAFTER\n{restored}"
        evidence["cases"].append("all-column restoration including zero auto-increment, decimal, bytes/text/NULL")
        evidence["cases"].append("reverse transaction/row order and repeated primary-key changes")
        evidence["cases"].append("JSON uint64/int64/nested/null/float and DATETIME/TIMESTAMP/TIME microseconds; caller timezone restored")
        # Existing PK must prevent restoring a historical DELETE; rollback prior actions too.
        sql("""SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'; SET SESSION time_zone='+00:00';
INSERT INTO recovery_lab.items VALUES(20,X'00ff','new',0.123456,9,1,NULL,NULL,NULL,NULL);
UPDATE recovery_lab.items SET id=12,payload=X'abcd',label='after',amount=1.000001,v_count=-7,v_tx_active=0,
doc=CAST('{"n":-9007199254740993}' AS JSON),wall='2000-02-29 00:00:00.000001',
instant='2000-02-29 00:00:00.000001',duration='-00:00:00.000001' WHERE id=10;""")
        collision = sql(full_script, check=False)
        assert collision.returncode != 0, "existing historical PK was not rejected"
        # The latest inverse tx commits before the earlier tx fails. Compare the
        # earlier transaction's pre-call state, allowing that documented commit.
        assert "primary key already exists" in collision.stderr, collision.stderr
        assert sql("SELECT COUNT(*) FROM recovery_lab.items WHERE id=20;").stdout.strip() == "1", "earlier inverse transaction was not rolled back"
        assert sql("SELECT COUNT(*) FROM recovery_lab.items WHERE id=12;").stdout.strip() == "1"
        evidence["cases"].append("PK conflict rolls back active inverse tx; previous inverse tx remains committed")
        # A changed target schema must fail before any restoration DML.
        sql("ALTER TABLE recovery_lab.items ADD COLUMN changed INT NULL;")
        before_schema_conflict = state()
        schema_conflict = sql(script(starts), check=False)
        assert schema_conflict.returncode != 0 and "column count changed" in schema_conflict.stderr, schema_conflict.stderr
        assert state() == before_schema_conflict
        evidence["cases"].append("runtime target schema drift refuses before DML")
        (root / "baseline.tsv").write_text(baseline)
        (root / "changed.tsv").write_text(changed)
        (root / "restored.tsv").write_text(restored)
        evidence["status"] = "passed"
        print(json.dumps(evidence, indent=2))
    except Exception as error:
        evidence["status"] = "failed"
        evidence["error"] = str(error)
        raise
    finally:
        finish_run(root, evidence, server, server_log, socket_dir)


def finish_run(root, evidence, server, server_log, socket_dir):
    try:
        (root / "evidence.json").write_text(json.dumps(evidence, indent=2))
    finally:
        try:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)
        finally:
            server_log.close()
            # Delete only this harness's now-unoccupied short socket directory.
            if server.poll() is not None:
                for entry in socket_dir.iterdir():
                    entry.unlink()
                socket_dir.rmdir()


if __name__ == "__main__":
    main()
