use serde::{Deserialize, Serialize};

use crate::{RecoveryLog, Transaction};

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TransactionFilter {
    pub database: Option<String>,
    pub table: Option<String>,
    pub gtid: Option<String>,
    pub from_time: Option<u32>,
    pub to_time: Option<u32>,
    pub from_position: Option<u64>,
    pub to_position: Option<u64>,
}

impl RecoveryLog {
    pub fn matching_transactions(&self, filter: &TransactionFilter) -> Result<Vec<&Transaction>, String> {
        if matches!((filter.from_position, filter.to_position), (Some(a), Some(b)) if a >= b)
            || matches!((filter.from_time, filter.to_time), (Some(a), Some(b)) if a > b)
        {
            return Err("invalid transaction filter range".into());
        }
        Ok(self
            .transactions
            .iter()
            .filter(|tx| {
                filter.from_position.is_none_or(|p| tx.end_position > p)
                    && filter.to_position.is_none_or(|p| tx.start_position < p)
                    && filter.from_time.is_none_or(|t| tx.timestamp >= t)
                    && filter.to_time.is_none_or(|t| tx.timestamp <= t)
                    && filter.gtid.as_ref().is_none_or(|g| tx.gtid.as_ref() == Some(g))
                    && (filter.database.is_none() && filter.table.is_none()
                        || tx.rows.iter().any(|row| {
                            filter.database.as_ref().is_none_or(|db| row.database == db.as_bytes())
                                && filter.table.as_ref().is_none_or(|table| row.table == table.as_bytes())
                        }))
            })
            .collect())
    }
}
