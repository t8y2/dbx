use std::io::{self, Read};

use crate::reader::{invalid, scan, LogEvent};
use crate::RowChange;
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub struct Transaction {
    pub start_position: u64,
    pub end_position: u64,
    pub timestamp: u32,
    pub gtid: Option<String>,
    pub rows: Vec<RowChange>,
}

#[derive(Debug)]
pub struct RecoveryLog {
    pub(crate) transactions: Vec<Transaction>,
    pub(crate) sha256: String,
    pub(crate) barriers: Vec<(u64, u8)>,
    pub(crate) end_position: u64,
    pub(crate) server_version: String,
}

impl RecoveryLog {
    pub fn transactions(&self) -> &[Transaction] {
        &self.transactions
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

struct Hashed<R> {
    inner: R,
    digest: Sha256,
}

impl<R: Read> Read for Hashed<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(bytes)?;
        self.digest.update(&bytes[..count]);
        Ok(count)
    }
}

pub fn read_log<R: Read>(input: R) -> io::Result<RecoveryLog> {
    let mut input = Hashed { inner: input, digest: Sha256::new() };
    let mut log = RecoveryLog {
        transactions: Vec::new(),
        sha256: String::new(),
        barriers: Vec::new(),
        end_position: 0,
        server_version: String::new(),
    };
    let mut current: Option<Transaction> = None;
    let mut pending_gtid: Option<(u64, Option<String>)> = None;
    let mut rows = 0usize;
    let mut materialized = 0usize;
    let summary = scan(&mut input, |event| {
        match event {
            LogEvent::Gtid { position, value } => {
                if current.is_some() || pending_gtid.is_some() {
                    return Err(invalid("GTID before previous transaction ended"));
                }
                pending_gtid = Some((position, value));
            }
            LogEvent::Begin { position } => {
                if current.is_some() {
                    return Err(invalid("nested BEGIN"));
                }
                let (start_position, gtid) = pending_gtid.take().unwrap_or((position, None));
                current = Some(Transaction { start_position, end_position: 0, timestamp: 0, gtid, rows: Vec::new() });
            }
            LogEvent::Row(row) => {
                let tx = current.as_mut().ok_or_else(|| invalid("row outside a BEGIN transaction"))?;
                rows += 1;
                materialized = materialized
                    .saturating_add(row.event_size)
                    .saturating_add(row.wire_columns.len().saturating_mul(256));
                if rows > 50_000 || materialized > 128 * 1024 * 1024 {
                    return Err(invalid("recovery row/memory limit exceeded"));
                }
                tx.rows.push(row);
            }
            LogEvent::Commit { end_position, timestamp } => {
                let mut tx = current.take().ok_or_else(|| invalid("COMMIT without BEGIN"))?;
                tx.end_position = end_position;
                tx.timestamp = timestamp;
                if log.transactions.len() >= 10_000 {
                    return Err(invalid("recovery transaction limit exceeded"));
                }
                log.transactions.push(tx);
            }
            LogEvent::Rollback => {
                if current.take().is_none() {
                    return Err(invalid("ROLLBACK without BEGIN"));
                }
            }
            LogEvent::Barrier { position, event_type } => {
                if log.barriers.len() >= 1_000 {
                    return Err(invalid("unsupported-event limit exceeded"));
                }
                log.barriers.push((position, event_type));
                // An autocommit DDL consumes its preceding GTID, not a ROW transaction.
                if current.is_none() {
                    pending_gtid = None;
                }
            }
        }
        Ok(())
    })?;
    if current.is_some() || pending_gtid.is_some() {
        return Err(invalid("incomplete transaction at EOF"));
    }
    log.end_position = summary.end_position;
    log.server_version = summary.server_version;
    log.sha256 = format!("{:x}", input.digest.finalize());
    Ok(log)
}
