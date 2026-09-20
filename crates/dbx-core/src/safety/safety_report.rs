use crate::sql_risk::ImpactReport;

/// Generate a human-readable safety check report string.
pub fn generate_safety_report(report: &ImpactReport) -> String {
    let mut lines = Vec::new();

    lines.push("=== SQL Safety Check Report ===".to_string());
    lines.push(format!("Overall Risk: {}", report.overall_risk));

    if let Some(drl) = &report.ddl_risk_level {
        lines.push(format!("DDL Risk Level: {}", drl));
    } else {
        lines.push("DDL Risk Level: N/A (no DDL statements)".to_string());
    }

    lines.push(format!("Statement Count: {}", report.statement_count));
    lines.push(format!("Recommended Strategy: {}", report.recommended_strategy));
    lines.push(format!("Estimated Duration: {}", report.estimated_total_duration));
    lines.push(format!("Maintenance Window Required: {}", report.requires_maintenance_window));
    lines.push(format!("Reversible: {}", report.is_reversible));

    if !report.ddl_details.is_empty() {
        lines.push("\n--- DDL Details ---".to_string());
        for (i, detail) in report.ddl_details.iter().enumerate() {
            lines.push(format!(
                "  {}. [{}] {} — affects: {}",
                i + 1,
                detail.ddl_risk,
                detail.summary,
                detail.affected_objects.join(", ")
            ));
        }
    }

    if !report.estimated_locks.is_empty() {
        lines.push("\n--- Estimated Locks ---".to_string());
        for lock in &report.estimated_locks {
            lines.push(format!(
                "  {}: {} lock ({}) — {}",
                lock.object, lock.lock_type, lock.scope, lock.estimated_duration
            ));
        }
    }

    if !report.warnings.is_empty() {
        lines.push("\n--- Warnings ---".to_string());
        for w in &report.warnings {
            lines.push(format!("  ! {}", w));
        }
    }

    lines.join("\n")
}
