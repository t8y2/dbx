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

    let mut mac = HmacSha1::new_from_slice(&key).map_err(|error| format!("TOTP secret is unusable: {error}"))?;
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
/// This is a *text* match only. Whether the code may actually be submitted is
/// decided per challenge by [`challenge_allows_local_answer`], which is the
/// only thing callers should use to gate an automatic answer: a challenge can
/// contain a prompt that matches here and still not be safe to answer locally.
pub fn is_totp_prompt(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    const MARKERS: [&str; 9] =
        ["otp", "totp", "one-time", "one time", "verification code", "authenticator", "验证码", "动态密码", "动态口令"];
    MARKERS.iter().any(|marker| prompt.contains(marker))
}

/// Whether an entire keyboard-interactive challenge may be answered with a
/// locally generated code.
///
/// The decision is deliberately made per *challenge*, not per prompt: a
/// challenge is answered as a single unit, so a form that mixes a code prompt
/// with anything else would otherwise have half its answers generated and half
/// prompted, and the code would be spent even when the server rejects the form.
///
/// Only the one shape DBX can be certain about qualifies:
///
/// * exactly one prompt — a multi-question form can carry a hidden password
///   field alongside the code;
/// * not echoed — an echoed answer is displayed on screen, and a one-time code
///   must never be written in the clear;
/// * the prompt text names a one-time code (see [`is_totp_prompt`]);
/// * a non-blank secret is configured;
/// * no code was spent yet, so a second round after the server rejected the
///   first code falls back to the dialog instead of burning fresh codes.
///
/// Everything else falls through to the interactive path, which is where a
/// headless host deliberately fails closed rather than guess a credential.
pub fn challenge_allows_local_answer(secret: Option<&str>, prompts: &[(&str, bool)], totp_spent: bool) -> bool {
    if totp_spent {
        return false;
    }
    if secret.is_none_or(|secret| secret.trim().is_empty()) {
        return false;
    }
    let [(prompt, echo)] = prompts else {
        return false;
    };
    !echo && is_totp_prompt(prompt)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B, SHA-1 rows. The SHA-256/SHA-512 rows use different
    /// secrets and are out of scope for this module.
    ///
    /// The RFC tabulates 8-digit codes; DBX implements the 6-digit default that
    /// authenticator apps and bastions use, so each expected value below is the
    /// low 6 digits of the RFC's 8. (`T=1111111109` is `07081804` in the RFC,
    /// hence `081804` here.)
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

    const SECRET: Option<&str> = Some("JBSWY3DPEHPK3PXP");

    /// The only shape that qualifies: one non-echoed prompt naming a code.
    #[test]
    fn challenge_answers_the_plain_code_prompt_locally() {
        assert!(challenge_allows_local_answer(SECRET, &[("OTP Code: ", false)], false));
        assert!(challenge_allows_local_answer(SECRET, &[("请输入验证码", false)], false));
    }

    /// An echoed answer is shown on screen; a one-time code must never be
    /// written in the clear, so an echoed code prompt stays interactive.
    #[test]
    fn challenge_never_answers_an_echoed_prompt() {
        assert!(!challenge_allows_local_answer(SECRET, &[("OTP Code: ", true)], false));
        assert!(!challenge_allows_local_answer(SECRET, &[("Verification code:", true)], false));
    }

    /// A form mixing the code with another field must stay fully interactive:
    /// answering it locally would also spend the code on a form the server may
    /// reject, and the neighbours could be credentials DBX must not fill.
    #[test]
    fn challenge_never_answers_a_multi_prompt_form() {
        assert!(!challenge_allows_local_answer(SECRET, &[("Username: ", false), ("OTP Code: ", false)], false));
        assert!(!challenge_allows_local_answer(SECRET, &[("OTP Code: ", false), ("Password: ", false)], false));
        assert!(!challenge_allows_local_answer(SECRET, &[], false));
    }

    /// A code is single-use per session: once spent, later rounds are prompted.
    #[test]
    fn challenge_answers_nothing_once_the_code_was_spent() {
        let prompts = [("OTP Code: ", false)];
        assert!(challenge_allows_local_answer(SECRET, &prompts, false));
        assert!(!challenge_allows_local_answer(SECRET, &prompts, true));
    }

    /// No secret, or only whitespace, keeps the previous interactive behaviour.
    #[test]
    fn challenge_requires_a_configured_secret() {
        let prompts = [("OTP Code: ", false)];
        assert!(!challenge_allows_local_answer(None, &prompts, false));
        assert!(!challenge_allows_local_answer(Some(""), &prompts, false));
        assert!(!challenge_allows_local_answer(Some("   "), &prompts, false));
    }
}
