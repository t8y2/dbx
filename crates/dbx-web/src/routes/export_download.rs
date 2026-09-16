use std::fmt::Write;

pub(crate) fn export_download_filename(requested_path: &str, fallback_base: &str, extension: &str) -> String {
    let requested_name = requested_path.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    let fallback_name = format!("{fallback_base}.{extension}");
    let is_web_placeholder = requested_name.starts_with("__web_export_")
        && requested_name.to_ascii_lowercase().ends_with(&format!(".{extension}").to_ascii_lowercase());
    let source = if requested_name.is_empty() || is_web_placeholder { fallback_name.as_str() } else { requested_name };
    let mut sanitized = source
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '"' | ';' | '/' | '\\' | '<' | '>' | ':' | '|' | '?' | '*')
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    sanitized = sanitized.trim_matches([' ', '.']).to_string();
    if sanitized.is_empty() {
        sanitized = fallback_name;
    }

    let expected_suffix = format!(".{extension}");
    if !sanitized.to_ascii_lowercase().ends_with(&expected_suffix.to_ascii_lowercase()) {
        sanitized.push_str(&expected_suffix);
    }
    sanitized
}

pub(crate) fn attachment_content_disposition(file_name: &str) -> String {
    let fallback = file_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ' ' | '(' | ')') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{}", encode_rfc5987_value(file_name))
}

fn encode_rfc5987_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(byte, b'!' | b'#' | b'$' | b'&' | b'+' | b'-' | b'.' | b'^' | b'_' | b'`' | b'|' | b'~')
        {
            encoded.push(char::from(byte));
        } else {
            write!(&mut encoded, "%{byte:02X}").expect("writing to a String cannot fail");
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_download_names_keep_the_requested_basename_and_expected_extension() {
        assert_eq!(
            export_download_filename(r"C:\\exports\\custom_question_260812161843.xlsx", "agents", "xlsx"),
            "custom_question_260812161843.xlsx"
        );
        assert_eq!(export_download_filename("__web_export_123.xlsx", "agents", "xlsx"), "agents.xlsx");
        assert_eq!(export_download_filename("../../unsafe.csv", "agents", "xlsx"), "unsafe.csv.xlsx");
        assert_eq!(export_download_filename("\r\n\".xlsx", "agents", "xlsx"), "_.xlsx");
        assert_eq!(export_download_filename("", "agents", "xlsx"), "agents.xlsx");
    }

    #[test]
    fn content_disposition_supports_unicode_without_unsafe_header_characters() {
        assert_eq!(
            attachment_content_disposition("智能体列表.xlsx"),
            "attachment; filename=\"_____.xlsx\"; filename*=UTF-8''%E6%99%BA%E8%83%BD%E4%BD%93%E5%88%97%E8%A1%A8.xlsx"
        );
    }
}
