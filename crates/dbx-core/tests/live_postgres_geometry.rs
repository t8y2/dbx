use std::time::Duration;

#[tokio::test]
#[ignore = "requires DBX_TEST_POSTGRES_GEOMETRY_URL pointing at a PostGIS database such as local-pg/test_geometry"]
async fn live_postgres_geometry_values_render_as_text_in_query_results() {
    let url = std::env::var("DBX_TEST_POSTGRES_GEOMETRY_URL").expect("DBX_TEST_POSTGRES_GEOMETRY_URL");
    let pool = dbx_core::db::postgres::connect(&url, Duration::from_secs(5)).await.expect("connect");
    let result = dbx_core::db::postgres::execute_query(
        &pool,
        "select id, geom, simple_geom from public.geo_test where id in (1, 7, 8) order by id",
    )
    .await
    .expect("query geometry rows");

    assert_eq!(result.columns, vec!["id", "geom", "simple_geom"]);
    assert_eq!(result.rows.len(), 3);

    assert_eq!(result.rows[0][0], serde_json::json!(1));
    assert_eq!(result.rows[0][1], serde_json::json!("POINT(116.397 39.908)"));
    assert_eq!(result.rows[0][2], serde_json::Value::Null);

    assert_eq!(result.rows[1][0], serde_json::json!(7));
    assert_eq!(result.rows[1][1], serde_json::Value::Null);
    assert_eq!(result.rows[1][2], serde_json::Value::Null);

    assert_eq!(result.rows[2][0], serde_json::json!(8));
    assert_eq!(result.rows[2][1], serde_json::Value::Null);
    assert_eq!(result.rows[2][2], serde_json::json!("POINT(120 30)"));
}
