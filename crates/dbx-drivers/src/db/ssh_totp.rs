//! RFC 6238 TOTP generation for SSH keyboard-interactive MFA.
//!
//! Headless hosts (`dbx-mcp`) have no prompt UI, so `request_ssh_prompt`
//! returns `None` and any keyboard-interactive challenge fails closed. A
//! connection that stores its TOTP secret can answer the challenge locally
//! instead, which keeps the fail-closed guarantee for every *other* prompt
//! (host keys, unknown questions) while making MFA bastions reachable.
//!
//! Scope is deliberately narrow: RFC 6238 with its defaults (HMAC-SHA1, 6
//! digits, 30-second steps), which is what authenticator apps and the MFA
//! bastions DBX targets use in practice. HOTP counter mode, alternate digits
//! and alternate periods are out of scope rather than guessed at.

use hmac::{Hmac, Mac};
use sha1::Sha1;

type HmacSha1 = Hmac<Sha1>;

/// RFC 6238 default time step, in seconds.
const TIME_STEP_SECS: u64 = 30;

/// RFC 6238 default code length.
const CODE_DIGITS: u32 = 6;

/// Decodes unpadded Base32 (RFC 4648 §6), the encoding every authenticator
/// app exports its secret in.
///
/// Eight characters carry five bytes; a trailing partial group is decoded by
/// the same shift-accumulate loop and simply yields fewer bytes, which is what
/// the unpadded form requires. Kept local rather than taking a dependency for
/// the single call site here.
fn base32_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 5 / 8 + 1);
    let (mut acc, mut bits) = (0u32, 0u32);
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => return None,
        };
        acc = (acc << 5) | u32::from(value);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// Generates the code for one explicit time step.
///
/// `unix_time` is passed in rather than read from the clock so the RFC 6238
/// test vectors can drive this directly.
pub fn generate_code(secret: &str, unix_time: u64) -> Result<String, String> {
    let key =
        base32_decode(secret).ok_or_else(|| "TOTP secret is not valid Base32 (expected A-Z and 2-7).".to_string())?;
    let counter = (unix_time / TIME_STEP_SECS).to_be_bytes();

    let mut mac =
        HmacSha1::new_from_slice(&key).map_err(|error| format!("TOTP secret is unusable: {error}"))?;
    mac.update(&counter);
    let digest = mac.finalize().into_bytes();

    // RFC 4226 §5.3 dynamic truncation: the low nibble of the last byte picks
    // the 4-byte window, then the top bit is masked off to avoid sign issues.
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);

    Ok(format!("{:0width$}", binary % 10u32.pow(CODE_DIGITS), width = CODE_DIGITS as usize))
}

/// Whether a keyboard-interactive prompt is asking for a TOTP code.
///
/// Only used to decide whether DBX may answer *on the user's behalf*, so it
/// errs toward not matching: a prompt we do not recognise falls through to the
/// interactive dialog and, headless, to the existing fail-closed path.
pub fn is_totp_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    const MARKERS: [&str; 9] = [
        "otp",
        "totp",
        "one-time",
        "one time",
        "verification code",
        "authenticator",
        "验证码",
        "动态密码",
        "动态口令",
    ];
    MARKERS.iter().any(|marker| prompt.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B, SHA-1 rows. The SHA-256/SHA-512 rows use different
    /// secrets and are out of scope for this module.
    #[test]
    fn rfc6238_sha1_vectors() {
        // ASCII "12345678901234567890", the RFC's seed, in Base32.
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let vectors = [
            (59u64, "287082"),
            (1111111109, "081804"),
            (1111111111, "050471"),
            (1234567890, "005924"),
            (2000000000, "279037"),
            (20000000000, "353130"),
        ];
        for (time, expected) in vectors {
            assert_eq!(generate_code(secret, time).unwrap(), expected, "T={time}");
        }
    }

    #[test]
    fn base32_decodes_the_rfc_seed() {
        assert_eq!(base32_decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap(), b"12345678901234567890");
        assert!(base32_decode("GEZD1NBV").is_none(), "'1' is outside the alphabet");
    }

    /// The same code must repeat within a step and change across one.
    #[test]
    fn codes_are_stable_within_a_step() {
        let secret = "JBSWY3DPEHPK3PXP";
        let start = 1_700_000_000u64 - 1_700_000_000 % TIME_STEP_SECS;
        assert_eq!(generate_code(secret, start).unwrap(), generate_code(secret, start + TIME_STEP_SECS - 1).unwrap());
        assert_ne!(generate_code(secret, start).unwrap(), generate_code(secret, start + TIME_STEP_SECS).unwrap());
    }

    #[test]
    fn prompt_matching_covers_the_common_bastion_wording() {
        assert!(is_totp_prompt("OTP Code: "));
        assert!(is_totp_prompt("Verification code:"));
        assert!(is_totp_prompt("Enter your authenticator token"));
        assert!(is_totp_prompt("请输入验证码"));
        assert!(is_totp_prompt("动态密码"));
    }

    /// Anything DBX cannot attribute to a TOTP challenge must not be answered
    /// on the user's behalf — those prompts stay interactive or fail closed.
    #[test]
    fn prompt_matching_leaves_unknown_questions_alone() {
        assert!(!is_totp_prompt("Password: "));
        assert!(!is_totp_prompt("Which account do you want?"));
        assert!(!is_totp_prompt(""));
    }
}
