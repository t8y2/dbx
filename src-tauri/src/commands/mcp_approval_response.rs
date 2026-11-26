//! Human approval responses shared by the SQL and tool bridge handlers.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SqlApprovalDecision {
    Once,
    Hour,
    Day,
    Deny(Option<String>),
}

impl SqlApprovalDecision {
    pub fn from_response(decision: &str, reason: Option<String>) -> Result<Self, String> {
        match decision {
            "once" => Ok(Self::Once),
            "hour" => Ok(Self::Hour),
            "day" => Ok(Self::Day),
            "deny" => {
                let reason = reason.map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
                if reason.as_ref().is_some_and(|text| text.chars().count() > 1_000) {
                    return Err("MCP rejection reason exceeds 1000 characters.".to_string());
                }
                Ok(Self::Deny(reason))
            }
            _ => Err("Invalid MCP SQL approval decision.".to_string()),
        }
    }

    pub fn denial_message(&self, prefix: &str) -> Option<String> {
        match self {
            Self::Deny(Some(reason)) => {
                // Keep user-provided text visibly separated and escaped as data.
                Some(format!("{prefix} User-provided rejection reason: {}", serde_json::to_string(reason).unwrap()))
            }
            Self::Deny(None) => Some(prefix.to_string()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denial_reasons_reach_both_error_kinds_as_quoted_user_data() {
        let decision =
            SqlApprovalDecision::from_response("deny", Some("  请缩小范围\n不要删除全部数据  ".into())).unwrap();
        for prefix in ["SQL_BLOCKED: MCP approval denied.", "TOOL_BLOCKED: MCP confirmation denied."] {
            let message = decision.denial_message(prefix).unwrap();
            assert!(message.starts_with(prefix));
            let encoded = message.split_once("User-provided rejection reason: ").unwrap().1;
            assert_eq!(serde_json::from_str::<String>(encoded).unwrap(), "请缩小范围\n不要删除全部数据");
            assert!(!message.contains('\n'));
        }
    }

    #[test]
    fn absent_reasons_preserve_existing_errors_and_never_grant_access() {
        for reason in [None, Some("  \n  ".into())] {
            let decision = SqlApprovalDecision::from_response("deny", reason).unwrap();
            assert_eq!(decision, SqlApprovalDecision::Deny(None));
            assert_eq!(decision.denial_message("TOOL_BLOCKED: denied"), Some("TOOL_BLOCKED: denied".into()));
        }
        assert!(SqlApprovalDecision::from_response("invalid", None).is_err());
    }

    #[test]
    fn reason_limits_are_unicode_aware_and_reasons_do_not_change_approval_choices() {
        assert!(SqlApprovalDecision::from_response("deny", Some("🙂".repeat(1_000))).is_ok());
        assert!(SqlApprovalDecision::from_response("deny", Some("中".repeat(1_001))).is_err());
        for choice in ["once", "hour", "day"] {
            let decision = SqlApprovalDecision::from_response(choice, Some("not a denial".into())).unwrap();
            assert!(decision.denial_message("blocked").is_none());
        }
    }
}
