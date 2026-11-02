#[path = "../src/data/sample_pairing.rs"]
mod sample_pairing;

use sample_pairing::retain_shared_sample_rows_by_key;

#[test]
fn independently_sampled_rows_keep_only_shared_keys() {
    let source = vec![(1, "source-only"), (2, "shared")];
    let target = vec![(2, "shared"), (3, "target-only")];

    let (source, target) = retain_shared_sample_rows_by_key(source, target, |row| row.0);

    assert_eq!(source, vec![(2, "shared")]);
    assert_eq!(target, vec![(2, "shared")]);
}

#[test]
fn paired_samples_preserve_real_duplicate_keys() {
    let source = vec![(1, "first"), (1, "duplicate")];
    let target = vec![(1, "target")];

    let (source, target) = retain_shared_sample_rows_by_key(source, target, |row| row.0);

    assert_eq!(source, vec![(1, "first"), (1, "duplicate")]);
    assert_eq!(target, vec![(1, "target")]);
}
