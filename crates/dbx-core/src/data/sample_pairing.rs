use std::collections::HashSet;
use std::hash::Hash;

pub(super) fn retain_shared_sample_rows_by_key<Row, Key, KeyFn>(
    source_rows: Vec<Row>,
    target_rows: Vec<Row>,
    key_for_row: KeyFn,
) -> (Vec<Row>, Vec<Row>)
where
    Key: Eq + Hash,
    KeyFn: Fn(&Row) -> Key,
{
    let source_keys = source_rows.iter().map(&key_for_row).collect::<HashSet<_>>();
    let target_keys = target_rows.iter().map(&key_for_row).collect::<HashSet<_>>();
    let source_rows = source_rows.into_iter().filter(|row| target_keys.contains(&key_for_row(row))).collect();
    let target_rows = target_rows.into_iter().filter(|row| source_keys.contains(&key_for_row(row))).collect();
    (source_rows, target_rows)
}
