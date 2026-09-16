use std::time::Duration;

use dbx_core::db::postgres;

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_URL pointing at a PostgreSQL database"]
async fn postgres_daterange_values_render_as_readable_ranges() {
    let url = std::env::var("DBX_TEST_POSTGRES_URL").expect("DBX_TEST_POSTGRES_URL");
    let pool = postgres::connect(&url, Duration::from_secs(5)).await.expect("connect postgres");

    let result = postgres::execute_query(
        &pool,
        "SELECT daterange(DATE '2025-02-01', DATE '2025-02-06', '[)') AS bounded, \
         'empty'::daterange AS empty, \
         daterange(NULL, DATE '2025-02-06', '()') AS lower_unbounded",
    )
    .await
    .expect("select daterange values");

    assert_eq!(result.column_types, vec!["daterange", "daterange", "daterange"]);
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0][0].as_str(), Some("[2025-02-01,2025-02-06)"));
    assert_eq!(result.rows[0][1].as_str(), Some("empty"));
    assert_eq!(result.rows[0][2].as_str(), Some("(,2025-02-06)"));
}
