//! Verify captured live Agent responses survive the desktop's typed JSON boundary.
//! Usage: cargo run -p dbx-types --example query_timing_roundtrip -- <live-results.json>
use dbx_types::types::QueryResult;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let file = std::env::args().nth(1).ok_or("expected live-results.json")?;
    let records: Vec<serde_json::Value> = serde_json::from_slice(&std::fs::read(file)?)?;
    for record in &records {
        let input = record["result"].clone();
        let result: QueryResult = serde_json::from_value(input.clone())?;
        let output = serde_json::to_value(result)?;
        assert_eq!(output["query_timings_ms"], input["query_timings_ms"]);
        assert_eq!(output["server_execute_time_us"], input["server_execute_time_us"]);
        assert_eq!(output["rows"], input["rows"]);
    }
    println!("PASS: {} live responses preserve timings and rows", records.len());
    Ok(())
}
