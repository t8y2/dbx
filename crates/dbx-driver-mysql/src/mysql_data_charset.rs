//! Explicit interpretation of MySQL latin1 byte-container text. Never an encoder.
use crate::models::connection::{ConnectionConfig, DatabaseType};
use encoding_rs::{DecoderResult, Encoding, BIG5, GB18030, GBK};
use percent_encoding::percent_decode_str;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MySqlDataCharset {
    Gbk,
    Gb18030,
    Big5,
}

pub fn data_charset_for_config(config: &ConnectionConfig) -> Result<Option<MySqlDataCharset>, String> {
    if config.db_type != DatabaseType::Mysql {
        return Ok(None);
    }
    let selected = data_charset_from_params(config.url_params.as_deref().unwrap_or(""))?;
    let profile = config.driver_profile.as_deref().unwrap_or("").trim();
    if selected.is_some() && !profile.is_empty() && !profile.eq_ignore_ascii_case("mysql") {
        return Err(
            "MySQL dataCharset is only supported by the native MySQL product, not MySQL-compatible profiles".into()
        );
    }
    Ok(selected)
}

pub fn data_charset_from_url(url: &str) -> Result<Option<MySqlDataCharset>, String> {
    data_charset_from_params(url.split_once('?').map_or("", |(_, params)| params))
}

fn decode_form_component(value: &str) -> String {
    percent_decode_str(&value.replace('+', " ")).decode_utf8_lossy().into_owned()
}

/// Parse raw connection URL parameters using the same form semantics as the
/// driver URL path. Product-level gates must use this before opening a pool.
pub fn data_charset_from_params(params: &str) -> Result<Option<MySqlDataCharset>, String> {
    // Match URLSearchParams form decoding. Inspect every occurrence rather than
    // applying first/last-wins semantics to security-relevant session options.
    let params = params.trim().trim_start_matches('?');
    let options: Vec<_> = params
        .split('&')
        .map(|segment| {
            let (key, value) = segment.split_once('=').unwrap_or((segment, ""));
            (decode_form_component(key).trim().to_owned(), decode_form_component(value), segment.contains('='))
        })
        .collect();
    if !options.iter().any(|(key, _, _)| key.eq_ignore_ascii_case("dataCharset")) {
        return Ok(None);
    }

    let mut selected = None;
    let mut seen = false;
    let mut charset_seen = false;
    let mut incompatible = false;
    for (key, value, has_equals) in options {
        if key.eq_ignore_ascii_case("dataCharset") {
            if seen {
                return Err("Duplicate MySQL dataCharset option".into());
            }
            seen = true;
            selected = Some(match value.to_ascii_uppercase().as_str() {
                "GBK" => MySqlDataCharset::Gbk,
                "GB18030" => MySqlDataCharset::Gb18030,
                "BIG5" => MySqlDataCharset::Big5,
                _ => return Err("MySQL dataCharset must be GBK, GB18030 or BIG5".into()),
            });
        } else if key.eq_ignore_ascii_case("charset") {
            if charset_seen {
                return Err("Duplicate MySQL charset option with dataCharset".into());
            }
            charset_seen = true;
            incompatible |= !value.eq_ignore_ascii_case("utf8mb4");
        } else if key.eq_ignore_ascii_case("sessionVariables") {
            incompatible |= !value.is_empty();
        } else if key.eq_ignore_ascii_case("setupMode") || key.eq_ignore_ascii_case("setup_mode") {
            incompatible |= !value.eq_ignore_ascii_case("standard");
        } else if key.eq_ignore_ascii_case("proxySql") {
            // The existing setup parser treats a bare flag as true and trims
            // boolean values; the validation must not miss either spelling.
            incompatible |= !has_equals
                || value.trim().is_empty()
                || matches!(value.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on");
        }
    }
    if incompatible {
        return Err("MySQL dataCharset requires the default/utf8mb4 charset and standard session setup without sessionVariables".into());
    }
    Ok(selected)
}

// MySQL's latin1 is CP1252, including the five undefined C1 control slots.
// Other C1 code points are not carriers: accepting them would not be reversible.
fn carrier_byte(c: char) -> Option<u8> {
    const SPECIAL: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘',
        '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    match c as u32 {
        0..=0x7f | 0xa0..=0xff => Some(c as u8),
        _ => SPECIAL.iter().position(|&candidate| candidate == c).map(|i| i as u8 + 0x80),
    }
}

fn prefix(text: &str, limit: usize) -> &str {
    let mut end = limit.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

impl MySqlDataCharset {
    /// Interpret a complete, untouched UTF8 carrier after core has established
    /// that a server-side preview was not truncated.
    pub fn interpret_text(self, original: &str) -> String {
        self.interpret(original, usize::MAX)
    }

    fn encoding(self) -> &'static Encoding {
        match self {
            Self::Gbk => GBK,
            Self::Gb18030 => GB18030,
            Self::Big5 => BIG5,
        }
    }

    /// Validate the entire value, retaining at most `limit` UTF8 bytes. Scanning
    /// the suffix is necessary: a late invalid byte must preserve the original
    /// carrier in previews just as it does in complete values. Auxiliary memory
    /// is constant apart from the explicitly bounded result.
    pub(crate) fn interpret(self, original: &str, limit: usize) -> String {
        self.decode(original, limit).unwrap_or_else(|| prefix(original, limit).to_owned())
    }

    fn decode(self, original: &str, limit: usize) -> Option<String> {
        let mut decoder = self.encoding().new_decoder_without_bom_handling();
        let mut chars = original.chars();
        let mut output = String::with_capacity(limit.min(original.len()));
        let mut prefix_full = false;
        let mut gbk_lead = false;
        loop {
            let mut input = [0u8; 1024];
            let mut count = 0;
            for byte in &mut input {
                let Some(c) = chars.next() else { break };
                *byte = carrier_byte(c)?;
                // encoding_rs intentionally shares the WHATWG GBK/GB18030
                // decoder. GBK opt-in must not accept GB18030 four-byte forms.
                if self == Self::Gbk {
                    if gbk_lead {
                        if byte.is_ascii_digit() {
                            return None;
                        }
                        gbk_lead = false;
                    } else {
                        gbk_lead = (0x81..=0xfe).contains(byte);
                    }
                }
                count += 1;
            }
            let last = count < input.len();
            let mut consumed = 0;
            loop {
                let mut buffer = [0u8; 4096];
                let (result, read, written) =
                    decoder.decode_to_utf8_without_replacement(&input[consumed..count], &mut buffer, last);
                consumed += read;
                let text = std::str::from_utf8(&buffer[..written]).ok()?;
                if !prefix_full {
                    let part = prefix(text, limit.saturating_sub(output.len()));
                    output.push_str(part);
                    prefix_full = part.len() < text.len() || output.len() == limit;
                }
                match result {
                    DecoderResult::Malformed(_, _) => return None,
                    DecoderResult::InputEmpty => break,
                    DecoderResult::OutputFull => {}
                }
            }
            if last {
                return Some(output);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_charset_is_scoped_to_the_mysql_product_not_protocol_profiles() {
        let mut config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id":"codec-test", "name":"codec-test", "db_type":"mysql", "host":"localhost",
            "port":3306, "username":"test", "password":"", "database":null,
            "url_params":"dataCharset=GBK"
        }))
        .unwrap();
        for profile in [None, Some(""), Some("  "), Some("mysql"), Some(" MySQL ")] {
            config.driver_profile = profile.map(str::to_owned);
            assert_eq!(data_charset_for_config(&config).unwrap(), Some(MySqlDataCharset::Gbk));
        }
        for profile in ["mariadb", "tidb", "doris", "custom"] {
            config.driver_profile = Some(profile.into());
            assert!(data_charset_for_config(&config).unwrap_err().contains("native MySQL product"));
            config.url_params = None;
            assert_eq!(data_charset_for_config(&config).unwrap(), None);
            config.url_params = Some("dataCharset=GBK".into());
        }
        // Firebird already owns a separate dataCharset option; never parse it
        // using this MySQL-specific policy.
        config.db_type = DatabaseType::Firebird;
        config.url_params = Some("dataCharset=not-a-mysql-option".into());
        assert_eq!(data_charset_for_config(&config).unwrap(), None);
    }

    #[test]
    fn explicit_options_validate_without_changing_default() {
        assert_eq!(data_charset_from_params("charset=latin1").unwrap(), None);
        for (name, expected) in
            [("gbk", MySqlDataCharset::Gbk), ("Gb18030", MySqlDataCharset::Gb18030), ("BIG5", MySqlDataCharset::Big5)]
        {
            assert_eq!(
                data_charset_from_params(&format!("dataCharset={name}&charset=UTF8MB4")).unwrap(),
                Some(expected)
            );
        }
        for params in [
            "dataCharset=",
            "dataCharset=utf8",
            "dataCharset=GBK&datacharset=GBK",
            "dataCharset=GBK&charset=latin1",
            "dataCharset=GBK&charset=utf8",
            "dataCharset=GBK&charset=utf8mb4&charset=gbk",
            "dataCharset=GBK&sessionVariables=character_set_results=latin1",
            "dataCharset=GBK&setupMode=bare",
            "dataCharset=GBK&proxySql=true",
        ] {
            assert!(data_charset_from_params(params).is_err(), "{params}");
        }
    }

    #[test]
    fn data_charset_form_decoding_and_session_options_match_url_semantics() {
        for params in [
            "%64ataCharset=%47BK",
            "?dataCharset=gbk&%63harset=UTF8MB4",
            "dataCharset=GBK&sessionVariables=",
            "dataCharset=GBK&proxySql=false",
            "dataCharset=GBK&setupMode=standard",
        ] {
            assert_eq!(data_charset_from_params(params).unwrap(), Some(MySqlDataCharset::Gbk), "{params}");
        }
        for params in [
            "dataCharset",
            "dataCharset=",
            "dataCharset=%20GBK%20",
            "dataCharset=GBK+",
            "dataCharset=GBK#fragment",
            "dataCharset=GBK&%64ataCharset=GBK",
            "dataCharset=GBK&charset=utf8mb4&CHARSET=utf8mb4",
            "dataCharset=GBK&%73essionVariables=character_set_results%3Dlatin1",
            "dataCharset=GBK&sessionVariables=+",
            "dataCharset=GBK&proxySql",
            "dataCharset=GBK&proxySql=",
            "dataCharset=GBK&proxySql=+",
            "dataCharset=GBK&proxySql=%20",
            "dataCharset=GBK&proxySql=%20true%20",
            "dataCharset=GBK&%70roxySql",
            "dataCharset=GBK&setup%4dode=compatible",
            "dataCharset=GBK&charset=%20utf8mb4%20",
            "dataCharset=GBK&+sessionVariables=character_set_results%3Dlatin1",
        ] {
            assert!(data_charset_from_params(params).is_err(), "{params}");
        }
        // Existing unrelated options retain their previous validation/behavior.
        assert_eq!(data_charset_from_params("charset=latin1&charset=gbk&proxySql").unwrap(), None);
    }

    #[test]
    fn strict_carrier_and_decoder_preserve_failures() {
        for (codec, original, expected) in [
            (MySqlDataCharset::Gbk, "çÍ·×²Êºç", "缤纷彩虹"),
            (MySqlDataCharset::Gbk, "¶ñ¶¾Èý½Ç", "恶毒三角"),
            (MySqlDataCharset::Gb18030, "ÖÐÎÄ”9ü6", "中文😀"),
            (MySqlDataCharset::Big5, "ÁcÅé¤¤¤å", "繁體中文"),
        ] {
            assert_eq!(codec.interpret(original, usize::MAX), expected);
            for limit in 0..expected.len() + 2 {
                assert_eq!(codec.interpret(original, limit), prefix(expected, limit));
            }
        }
        for codec in [MySqlDataCharset::Gbk, MySqlDataCharset::Gb18030, MySqlDataCharset::Big5] {
            for original in ["", "ASCII 123", "正常中文😀", "ÿ", "\u{80}", "leading ASCII \u{81}", "çÍ·×²Êºç中"]
            {
                assert_eq!(codec.interpret(original, usize::MAX), original);
            }
        }
        assert_eq!(MySqlDataCharset::Gbk.interpret("”9ü6", usize::MAX), "”9ü6");
        // Western text can be a valid carrier; interpretation is never detection.
        assert_eq!(MySqlDataCharset::Gbk.interpret("ÖÐ", usize::MAX), "中");
    }

    #[test]
    fn carrier_control_slots_are_exact() {
        let specials = "€\u{81}‚ƒ„…†‡ˆ‰Š‹Œ\u{8d}Ž\u{8f}\u{90}‘’“”•–—˜™š›œ\u{9d}žŸ";
        for (offset, c) in specials.chars().enumerate() {
            assert_eq!(carrier_byte(c), Some(0x80 + offset as u8));
        }
        for byte in 0u8..=255 {
            if !(0x80..=0x9f).contains(&byte) {
                assert_eq!(carrier_byte(char::from(byte)), Some(byte));
            }
        }
        for c in ['\u{80}', '\u{82}', '\u{9f}', '中', '😀'] {
            assert_eq!(carrier_byte(c), None);
        }
    }

    #[test]
    fn bounded_preview_checks_suffix_and_multibyte_chunk_boundary() {
        let original = format!("{}ÖÐ", "a".repeat(1023));
        assert_eq!(MySqlDataCharset::Gbk.interpret(&original, usize::MAX), format!("{}中", "a".repeat(1023)));
        let large = "çÍ·×²Êºç".repeat(100_000);
        assert_eq!(MySqlDataCharset::Gbk.interpret(&large, 5), "缤");
        let invalid_tail = format!("{large}ÿ");
        assert_eq!(MySqlDataCharset::Gbk.interpret(&invalid_tail, 5), prefix(&invalid_tail, 5));
        let unicode_tail = format!("{large}中");
        assert_eq!(MySqlDataCharset::Gbk.interpret(&unicode_tail, 5), prefix(&unicode_tail, 5));
        // EOF after an exact input-buffer multiple must flush the pending lead.
        let unfinished = format!("{}\u{81}", "a".repeat(1023));
        assert_eq!(MySqlDataCharset::Gbk.interpret(&unfinished, usize::MAX), unfinished);
    }
}
