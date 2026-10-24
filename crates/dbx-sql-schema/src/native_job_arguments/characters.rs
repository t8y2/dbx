use super::{ArgumentExpectation, ScalarType};

fn chunks(value: &str) -> Vec<(String, String, usize)> {
    let mut result = Vec::new();
    let mut encoded = String::new();
    let mut hex = String::new();
    let mut length = 0;
    for character in value.chars() {
        let mut units = [0; 2];
        for unit in character.encode_utf16(&mut units) {
            hex.push_str(&format!("{unit:04X}"));
            if *unit == 0x005C {
                encoded.push_str("\\\\");
            } else {
                encoded.push_str(&format!("\\{unit:04X}"));
            }
        }
        length += 1;
        if length == 256 {
            result.push((std::mem::take(&mut encoded), std::mem::take(&mut hex), length));
            length = 0;
        }
    }
    if length != 0 {
        result.push((encoded, hex, length));
    }
    result
}

fn check_piece(value: &str, hex: &str) -> String {
    format!("l_actual := SYS.UTL_I18N.STRING_TO_RAW({value}, 'AL16UTF16'); l_expected := HEXTORAW('{hex}'); IF l_actual IS NULL OR SYS.UTL_RAW.LENGTH(l_actual) <> SYS.UTL_RAW.LENGTH(l_expected) OR SYS.UTL_RAW.COMPARE(l_actual, l_expected) <> 0 THEN RAISE_APPLICATION_ERROR(-20001, 'native_job_argument_character_loss'); END IF; ")
}

pub(super) fn declarations() -> &'static str {
    "l_value_v VARCHAR2(32767 BYTE); l_value_n NVARCHAR2(32767); l_piece_v VARCHAR2(32767 BYTE); l_piece_n NVARCHAR2(32767); l_read_v VARCHAR2(32767 BYTE); l_read_n NVARCHAR2(32767); l_actual RAW(32767); l_expected RAW(32767); l_size PLS_INTEGER; "
}

pub(super) fn construction(expected: &ArgumentExpectation) -> Result<String, &'static str> {
    let value = expected
        .value
        .as_ref()
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("native_job_argument_value_invalid")?;
    // A scalar needs at least one target byte; reject values exceeding even that native hard bound.
    if value.chars().count() > 32_767 {
        return Err("native_job_argument_character_capacity");
    }
    let pieces = chunks(value);
    let national = matches!(expected.scalar_type, ScalarType::Nvarchar2 | ScalarType::Nchar);
    let (buffer, read, piece) =
        if national { ("l_value_n", "l_read_n", "l_piece_n") } else { ("l_value_v", "l_read_v", "l_piece_v") };
    let mut body = String::new();
    for (encoded, hex, _) in &pieces {
        body.push_str(&format!("l_piece_n := UNISTR('{encoded}'); "));
        if !national {
            body.push_str("l_piece_v := TO_CHAR(l_piece_n); ");
        }
        body.push_str(&check_piece(piece, hex));
        body.push_str(&format!("IF NVL(LENGTHB({buffer}), 0) + LENGTHB({piece}) > 32767 THEN RAISE_APPLICATION_ERROR(-20001, 'native_job_argument_character_capacity'); END IF; {buffer} := {buffer} || {piece}; "));
    }
    match expected.scalar_type {
        ScalarType::Char | ScalarType::Nchar => {
            let (length, suffix) = if national { ("LENGTH", "") } else { ("LENGTHB", " BYTE") };
            let datatype = if national { "NCHAR" } else { "CHAR" };
            body.push_str(&format!("l_size := {length}({buffer}); IF l_size NOT BETWEEN 1 AND 32767 THEN RAISE_APPLICATION_ERROR(-20001, 'native_job_argument_character_capacity'); END IF; EXECUTE IMMEDIATE 'DECLARE c {datatype}(' || TO_CHAR(l_size, 'FM99990', 'NLS_NUMERIC_CHARACTERS=''.,''') || ' {suffix}); BEGIN c := :v; :a := SYS.ANYDATA.{}(c); END;' USING IN {buffer}, OUT l_anydata; ", expected.scalar_type.convert()));
        }
        ScalarType::Varchar2 | ScalarType::Nvarchar2 => {
            body.push_str(&format!("l_anydata := SYS.ANYDATA.{}({buffer}); ", expected.scalar_type.convert()))
        }
        _ => return Err("native_job_argument_value_invalid"),
    }
    body.push_str(&format!("{read} := l_anydata.{}(); IF {read} IS NULL OR LENGTH4({read}) <> {} THEN RAISE_APPLICATION_ERROR(-20001, 'native_job_argument_character_loss'); END IF; ", expected.scalar_type.access(), value.chars().count()));
    let mut start = 1;
    for (_, hex, length) in &pieces {
        body.push_str(&check_piece(&format!("SUBSTR4({read}, {start}, {length})"), hex));
        start += length;
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unicode_chunks_keep_surrogate_pairs_backslashes_and_trailing_spaces_without_literal_collisions() {
        let parts = chunks(&format!("{}\\😀' ", "中".repeat(255)));
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].2, 256);
        assert!(parts[0].0.ends_with("\\\\"));
        assert_eq!(parts[1], ("\\D83D\\DE00\\0027\\0020".into(), "D83DDE0000270020".into(), 3));
        let literal = chunks("\\0041");
        assert_ne!(literal[0].0, chunks("A")[0].0);
        assert_eq!(literal[0].1, "005C0030003000340031");
    }
}
