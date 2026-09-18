#[cfg(test)]
mod tests {
    #[test]
    fn business_modules_do_not_consume_legacy_marker_fields() {
        let business_sources = [
            ("query.rs", include_str!("../src/query/mod.rs")),
            ("schema.rs", include_str!("../src/schema/mod.rs")),
            ("connection.rs", include_str!("../src/connection/mod.rs")),
        ];
        let retired_consumers = ["agent_rpc_error_category", "agent_rpc_error_session_id", "agent_session_disposition"];

        for (name, source) in business_sources {
            for consumer in retired_consumers {
                assert!(!source.contains(consumer), "{name} still consumes {consumer}");
            }
        }
    }
}
