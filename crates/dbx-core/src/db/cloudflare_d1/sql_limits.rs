use std::ops::Range;

pub const MAX_SQL_STATEMENT_BYTES: usize = 100_000;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct SqlBatch {
    pub sql: String,
    pub item_count: usize,
}

pub(super) fn build_sql_batches<F>(
    item_count: usize,
    max_items: usize,
    item_label: &str,
    render: F,
) -> Result<Vec<SqlBatch>, String>
where
    F: Fn(Range<usize>) -> String,
{
    let mut batches = Vec::new();
    let mut start = 0;
    let max_items = max_items.max(1);

    while start < item_count {
        let mut end = start + 1;
        let mut accepted = render(start..end);
        if accepted.len() > MAX_SQL_STATEMENT_BYTES {
            return Err(format!(
                "Cloudflare D1 {item_label} {} generates a {}-byte SQL statement; the maximum is {MAX_SQL_STATEMENT_BYTES} bytes. Reduce the value size because a single item cannot be split safely.",
                start + 1,
                accepted.len()
            ));
        }

        while end < item_count && end - start < max_items {
            let candidate = render(start..end + 1);
            if candidate.len() > MAX_SQL_STATEMENT_BYTES {
                break;
            }
            accepted = candidate;
            end += 1;
        }

        if !accepted.trim().is_empty() {
            batches.push(SqlBatch { sql: accepted, item_count: end - start });
        }
        start = end;
    }

    Ok(batches)
}

pub(super) fn validate_statement_sizes(sql: &str) -> Result<(), String> {
    let statements = super::sql_lexer::complete_sql_statements(sql);
    for (index, statement) in statements.iter().enumerate() {
        if statement.len() > MAX_SQL_STATEMENT_BYTES {
            return Err(statement_size_error(index + 1, statement.len()));
        }
    }
    Ok(())
}

fn statement_size_error(index: usize, byte_len: usize) -> String {
    format!(
        "Cloudflare D1 SQL statement {index} is {byte_len} bytes; the maximum is {MAX_SQL_STATEMENT_BYTES} bytes. Split the statement or reduce the batch/value size."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_utf8_sql_batches_by_bytes() {
        let rows = ["你".repeat(20_000), "好".repeat(20_000)];
        let batches = build_sql_batches(rows.len(), 100, "import row", |range| {
            format!("INSERT INTO events VALUES ('{}')", rows[range].join("'), ('"))
        })
        .unwrap();

        assert_eq!(batches.len(), 2);
        assert!(batches.iter().all(|batch| batch.sql.len() <= MAX_SQL_STATEMENT_BYTES));
    }

    #[test]
    fn rejects_a_single_oversized_item() {
        let error = build_sql_batches(1, 100, "import row", |_| {
            format!("INSERT INTO events VALUES ('{}')", "x".repeat(MAX_SQL_STATEMENT_BYTES))
        })
        .unwrap_err();

        assert!(error.contains("import row 1"));
        assert!(error.contains("maximum is 100000 bytes"));
    }

    #[test]
    fn validates_trigger_and_other_batch_statements_individually() {
        let trigger = "CREATE TRIGGER audit AFTER UPDATE ON users BEGIN INSERT INTO logs VALUES (NEW.id); END";
        let first = format!("SELECT '{}'", "a".repeat(60_000));
        let second = format!("SELECT '{}'", "b".repeat(60_000));

        assert!(validate_statement_sizes(&format!("{trigger}; {first}; {second}")).is_ok());
    }

    #[test]
    fn rejects_an_oversized_complete_trigger_statement() {
        let trigger = format!(
            "CREATE TRIGGER audit AFTER UPDATE ON users BEGIN INSERT INTO logs VALUES ('{}'); INSERT INTO logs VALUES ('{}'); END",
            "a".repeat(60_000),
            "b".repeat(60_000)
        );

        assert!(validate_statement_sizes(&trigger).is_err());
    }
}
