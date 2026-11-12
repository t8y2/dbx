use std::{
    fs::File,
    io::{self, BufReader, Read, Write},
    process::ExitCode,
};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    use dbx_mysql_binlog_probe::{plan_recovery, read_log, SchemaManifest, TransactionFilter};
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let usage = "usage: dbx-mysql-binlog-probe FILE | transactions FILE [FILTER_JSON] | recover FILE SCHEMA_JSON START_POSITION...";
    match args.first().and_then(|s| s.to_str()) {
        Some("--worker") if args.len() == 1 => {
            let mut bytes = Vec::new();
            io::stdin()
                .lock()
                .take((dbx_mysql_binlog_probe::worker::MAX_REQUEST_BYTES + 1) as u64)
                .read_to_end(&mut bytes)?;
            let response = dbx_mysql_binlog_probe::worker::handle_worker_request(&bytes)?;
            io::stdout().lock().write_all(response.as_bytes())?;
            return Ok(());
        }
        Some("transactions") if matches!(args.len(), 2 | 3) => {
            let parsed = read_log(BufReader::new(File::open(&args[1])?))?;
            let filter: TransactionFilter = if args.len() == 3 {
                let value = args[2].to_str().ok_or("filter must be UTF-8 JSON")?;
                if value.len() > 65536 {
                    return Err("filter too large".into());
                }
                serde_json::from_str(value)?
            } else {
                TransactionFilter::default()
            };
            let selected = parsed.matching_transactions(&filter)?;
            let transactions: Vec<_> = selected
                .iter()
                .map(|tx| {
                    let tables: std::collections::BTreeSet<_> =
                        tx.rows.iter().map(|row| (&row.database, &row.table)).collect();
                    let tables: Vec<_> = tables
                        .into_iter()
                        .map(|(db, table)| {
                            serde_json::json!({
                                "database_bytes":db, "table_bytes":table
                            })
                        })
                        .collect();
                    serde_json::json!({ "start_position":tx.start_position.to_string(),
                    "end_position":tx.end_position.to_string(), "commit_time":tx.timestamp,
                    "gtid":tx.gtid, "rows":tx.rows.len(), "tables":tables })
                })
                .collect();
            let value = serde_json::json!({ "warning":"transaction preview is not recovery eligibility", "sha256":parsed.sha256(), "transactions":transactions });
            writeln!(io::stdout().lock(), "{}", serde_json::to_string_pretty(&value)?)?;
            return Ok(());
        }
        Some("recover") if args.len() >= 4 => {
            let parsed = read_log(BufReader::new(File::open(&args[1])?))?;
            let mut bytes = Vec::new();
            File::open(&args[2])?.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > 4 * 1024 * 1024 {
                return Err("historical schema manifest exceeds 4 MiB".into());
            }
            let schema: SchemaManifest = serde_json::from_slice(&bytes)?;
            let starts = args[3..]
                .iter()
                .map(|s| {
                    s.to_str().ok_or("invalid start position")?.parse::<u64>().map_err(|_| "invalid start position")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let sql = plan_recovery(&parsed, &schema, &starts)?.to_sql()?;
            io::stdout().lock().write_all(sql.as_bytes())?;
            return Ok(());
        }
        Some("transactions" | "recover") => return Err(usage.into()),
        _ => {}
    }
    if args.len() != 1 {
        return Err(usage.into());
    }
    let result = dbx_mysql_binlog_probe::inspect(BufReader::new(File::open(&args[0])?), |_| {})?;
    let mut out = io::stdout().lock();
    writeln!(out, "Inspection only; not a recovery eligibility check")?;
    writeln!(out, "server_version={:?}", result.server_version)?;
    writeln!(
        out,
        "events={} rows={} commits={} partial_rows={} unsupported_events={} end_position={}",
        result.events, result.rows, result.commits, result.partial_rows, result.unsupported_events, result.end_position
    )?;
    for diagnostic in &result.diagnostics {
        writeln!(out, "unsupported event_type={} position={}", diagnostic.event_type, diagnostic.position)?;
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("binlog inspection failed: {error}");
            ExitCode::FAILURE
        }
    }
}
