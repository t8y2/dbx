/// Lightness and chroma of the light-theme `--group-c` token. Only hue
/// varies per group, which is what guarantees legible contrast.
const GROUP_LIGHTNESS: f64 = 0.55;
const GROUP_CHROMA: f64 = 0.15;

fn linear_to_srgb(channel: f64) -> f64 {
    if channel <= 0.003_130_8 {
        12.92 * channel
    } else {
        1.055 * channel.powf(1.0 / 2.4) - 0.055
    }
}

fn to_byte(channel: f64) -> u8 {
    (linear_to_srgb(channel).clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Convert a group hue to the sRGB hex DBML expects.
///
/// OKLCH -> OKLab -> LMS -> linear sRGB -> gamma-encoded sRGB.
/// Coefficients are Björn Ottosson's published OKLab matrices.
pub fn hue_to_hex(hue: u16) -> String {
    let radians = f64::from(hue % 360) * std::f64::consts::PI / 180.0;
    let a = GROUP_CHROMA * radians.cos();
    let b = GROUP_CHROMA * radians.sin();

    let l_ = GROUP_LIGHTNESS + 0.396_337_777_4 * a + 0.215_803_757_3 * b;
    let m_ = GROUP_LIGHTNESS - 0.105_561_345_8 * a - 0.063_854_172_8 * b;
    let s_ = GROUP_LIGHTNESS - 0.089_484_177_5 * a - 1.291_485_548_0 * b;

    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;

    let red = 4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s;
    let green = -1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s;
    let blue = -0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701_0 * s;

    format!("#{:02x}{:02x}{:02x}", to_byte(red), to_byte(green), to_byte(blue))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_a_six_digit_lowercase_hex_string() {
        let hex = hue_to_hex(28);
        assert_eq!(hex.len(), 7, "got {hex}");
        assert!(hex.starts_with('#'), "got {hex}");
        assert!(hex[1..].chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "got {hex}");
    }

    #[test]
    fn hue_28_is_a_warm_orange_red() {
        // Sanity check against the group palette: red channel dominates.
        let hex = hue_to_hex(28);
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap();
        let g = u8::from_str_radix(&hex[3..5], 16).unwrap();
        let b = u8::from_str_radix(&hex[5..7], 16).unwrap();
        assert!(r > g && g > b, "expected r > g > b, got {hex}");
    }

    #[test]
    fn hue_148_is_green_dominant() {
        let hex = hue_to_hex(148);
        let r = u8::from_str_radix(&hex[1..3], 16).unwrap();
        let g = u8::from_str_radix(&hex[3..5], 16).unwrap();
        assert!(g > r, "expected green to dominate, got {hex}");
    }

    #[test]
    fn every_hue_is_in_range_and_never_panics() {
        for hue in 0..=359u16 {
            let hex = hue_to_hex(hue);
            assert_eq!(hex.len(), 7, "hue {hue} produced {hex}");
        }
    }

    #[test]
    fn hue_wraps_past_360() {
        assert_eq!(hue_to_hex(0), hue_to_hex(360));
        assert_eq!(hue_to_hex(28), hue_to_hex(388));
    }
}
