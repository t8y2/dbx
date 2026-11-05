//! Image captcha for the Web login form.
//!
//! The Web build authenticates with one administrator password, and its only
//! built-in defence is a *global* failure counter (`auth::login`): any client
//! can trip it, and a distributed dictionary attack never trips it at all. A
//! per-login image challenge raises the cost of every guess to an OCR problem.
//!
//! Nothing new is pulled in to render it. The glyphs come from a built-in 5x7
//! bitmap font and the PNG is encoded in this module (zlib stored blocks), so
//! the server needs neither a font file, an image crate, nor a graphics stack.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a challenge stays valid. The frontend refreshes it on every failed
/// attempt, so a short TTL costs at most one extra round trip.
pub const CAPTCHA_TTL: Duration = Duration::from_secs(300);

/// Challenges left behind by abandoned logins must not accumulate: the store is
/// process-wide and reachable without a session.
const MAX_PENDING: usize = 512;

const CODE_LEN: usize = 5;

/// Ambiguous glyphs are excluded (0/O, 1/I, and the ones that blur into each
/// other once scaled and distorted), so a correct answer is never rejected by
/// the font itself.
const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

const WIDTH: usize = 180;
const HEIGHT: usize = 64;
const SCALE: usize = 4;

/// How the login form is protected by a challenge.
///
/// `auto` is the default: an ordinary first-try login looks exactly like before,
/// while a dictionary attack runs into an image challenge from its second
/// attempt on (the failure counter is global and only a successful login resets
/// it). `always` is for hardened deployments, `off` for ones already behind a
/// trusted network (the failure lockout still applies there).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptchaMode {
    Always,
    Auto,
    Off,
}

impl CaptchaMode {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "auto" => Self::Auto,
            "always" | "on" | "1" | "true" => Self::Always,
            "off" | "0" | "false" | "disabled" => Self::Off,
            other => {
                log::warn!("DBX_WEB_CAPTCHA={other:?} is not always|auto|off; falling back to always");
                Self::Always
            }
        }
    }

    /// Strict parser for the settings dialog: only the three canonical values
    /// are accepted, so a typo cannot silently change what the UI shows.
    pub fn from_user_input(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "always" => Some(Self::Always),
            "auto" => Some(Self::Auto),
            "off" => Some(Self::Off),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Always => "always",
            Self::Auto => "auto",
            Self::Off => "off",
        }
    }

    /// Whether the next login attempt must solve a challenge, given the number
    /// of failed attempts since the last successful login.
    pub fn requires_challenge(self, failed_attempts: u32) -> bool {
        match self {
            Self::Always => true,
            Self::Auto => failed_attempts > 0,
            Self::Off => false,
        }
    }
}

struct Challenge {
    code: String,
    issued: Instant,
}

/// In-memory, single-use, TTL-bounded captcha store.
#[derive(Default)]
pub struct CaptchaStore {
    pending: Mutex<HashMap<String, Challenge>>,
}

impl CaptchaStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issue a challenge. Returns `(id, png_bytes)`; the expected answer never
    /// leaves the server.
    pub fn issue(&self) -> (String, Vec<u8>) {
        let mut entropy = [0u8; 32];
        if getrandom::fill(&mut entropy).is_err() {
            // A broken OS RNG must not lock the administrator out of the app;
            // fall back to the clock and the queue length, which is still
            // unpredictable enough to keep the challenge out of a replay.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_le_bytes();
            entropy[..16].copy_from_slice(&now);
            let depth = self.lock().len() as u128;
            entropy[16..].copy_from_slice(&depth.to_le_bytes());
        }

        let code: String =
            entropy[..CODE_LEN].iter().map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char).collect();
        let image = render_png(&code, &entropy[CODE_LEN..]);
        let id = uuid::Uuid::new_v4().to_string();

        let now = Instant::now();
        let mut pending = self.lock();
        pending.retain(|_, challenge| now.duration_since(challenge.issued) < CAPTCHA_TTL);
        if pending.len() >= MAX_PENDING {
            // Evict the oldest instead of refusing to issue: a legitimate user
            // must never be blocked by somebody else's leftovers.
            let overflow = pending.len() - MAX_PENDING + 1;
            let mut oldest: Vec<(String, Instant)> =
                pending.iter().map(|(id, challenge)| (id.clone(), challenge.issued)).collect();
            oldest.sort_by_key(|(_, issued)| *issued);
            for (id, _) in oldest.into_iter().take(overflow) {
                pending.remove(&id);
            }
        }
        pending.insert(id.clone(), Challenge { code, issued: now });
        (id, image)
    }

    /// Single-use verification. The challenge is consumed even when the answer
    /// is wrong, so a solved or leaked image can never be replayed, and the
    /// caller cannot probe the same challenge twice.
    pub fn verify(&self, id: &str, answer: &str) -> bool {
        let challenge = self.lock().remove(id);
        let Some(challenge) = challenge else {
            return false;
        };
        if challenge.issued.elapsed() >= CAPTCHA_TTL {
            return false;
        }
        let answer = answer.trim();
        challenge.code.len() == answer.len() && challenge.code.eq_ignore_ascii_case(answer)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Challenge>> {
        self.pending.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Render the challenge as an RGB PNG.
fn render_png(code: &str, entropy: &[u8]) -> Vec<u8> {
    encode_png(WIDTH, HEIGHT, &render_rgb(code, entropy))
}

fn render_rgb(code: &str, entropy: &[u8]) -> Vec<u8> {
    let mut rng = Rng::new(entropy);
    let mut pixels = vec![0u8; WIDTH * HEIGHT * 3];

    // Background: light paper with a little grain. The channels are clamped
    // instead of cast: `base + delta` used to exceed 255 and wrap, painting the
    // paper with saturated noise.
    for pixel in pixels.chunks_exact_mut(3) {
        let base = 230u16 + u16::from(rng.next_u8() % 18);
        pixel[0] = base.min(255) as u8;
        pixel[1] = (base + u16::from(rng.next_u8() % 5)).min(255) as u8;
        pixel[2] = (base + u16::from(rng.next_u8() % 5)).min(255) as u8;
    }

    // Interference goes down before the glyphs so the answer stays legible:
    // light lines and specks behind the text still defeat naive thresholding and
    // component splitting without eating the strokes themselves.
    for _ in 0..2 {
        let x0 = rng.below(WIDTH);
        let y0 = rng.below(HEIGHT);
        let x1 = rng.below(WIDTH);
        let y1 = rng.below(HEIGHT);
        let shade = 198 + rng.next_u8() % 30;
        draw_line(&mut pixels, x0, y0, x1, y1, [shade, shade, shade]);
    }
    for _ in 0..60 {
        let x = rng.below(WIDTH);
        let y = rng.below(HEIGHT);
        let shade = 205 + rng.next_u8() % 35;
        put_pixel(&mut pixels, x, y, [shade, shade, shade]);
    }

    // Glyphs: dark, jittered per character so neither the baseline nor the
    // spacing is a fixed property of the font.
    let advance = (WIDTH - 24) / CODE_LEN;
    for (index, ch) in code.chars().enumerate() {
        let glyph = glyph_rows(ch);
        let origin_x = 12 + index * advance + rng.below(4);
        let origin_y = 8 + rng.below(7);
        let color = [rng.next_u8() % 24, rng.next_u8() % 24, rng.next_u8() % 34];
        draw_glyph(&mut pixels, glyph, origin_x, origin_y, color);
    }

    pixels
}

fn put_pixel(pixels: &mut [u8], x: usize, y: usize, color: [u8; 3]) {
    if x >= WIDTH || y >= HEIGHT {
        return;
    }
    let offset = (y * WIDTH + x) * 3;
    pixels[offset..offset + 3].copy_from_slice(&color);
}

fn draw_glyph(pixels: &mut [u8], rows: [u8; 7], origin_x: usize, origin_y: usize, color: [u8; 3]) {
    for (row, bits) in rows.iter().enumerate() {
        for column in 0..5 {
            if bits >> (4 - column) & 1 == 0 {
                continue;
            }
            for dy in 0..SCALE {
                for dx in 0..SCALE {
                    // A darker core keeps the glyph readable under the noise.
                    let shade = if dx == 0 && dy == 0 { color } else { [color[0] / 2, color[1] / 2, color[2] / 2] };
                    put_pixel(pixels, origin_x + column * SCALE + dx, origin_y + row * SCALE + dy, shade);
                }
            }
        }
    }
}

fn draw_line(pixels: &mut [u8], mut x0: usize, mut y0: usize, x1: usize, y1: usize, color: [u8; 3]) {
    // Bresenham, integer-only, mirroring on the x axis so either direction works.
    let (dx, dy) = ((x1 as isize - x0 as isize).abs(), (y1 as isize - y0 as isize).abs());
    let (sx, sy) = (if x0 < x1 { 1 } else { -1 }, if y0 < y1 { 1 } else { -1 });
    let mut error = dx - dy;
    let mut remaining = dx.max(dy) + 1;
    loop {
        put_pixel(pixels, x0, y0, color);
        if x0 == x1 && y0 == y1 {
            break;
        }
        let doubled = 2 * error;
        if doubled > -dy {
            error -= dy;
            x0 = (x0 as isize + sx) as usize;
        }
        if doubled < dx {
            error += dx;
            y0 = (y0 as isize + sy) as usize;
        }
        remaining -= 1;
        if remaining == 0 {
            break;
        }
    }
}

/// xorshift64* over the caller's entropy: deterministic per challenge and fast
/// enough to stay off the login latency path.
struct Rng {
    state: u64,
}

impl Rng {
    fn new(seed: &[u8]) -> Self {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for byte in seed {
            state = state.rotate_left(9) ^ u64::from(*byte).wrapping_mul(0x0000_0100_0000_01B3);
        }
        Self { state: state | 1 }
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    fn next_u8(&mut self) -> u8 {
        (self.next_u64() >> 33) as u8
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next_u64() % bound as u64) as usize
    }
}

/// 5x7 bitmap font, rows top to bottom, bit 4 is the leftmost pixel.
const GLYPHS: &[(u8, [u8; 7])] = &[
    (b'A', [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001]),
    (b'B', [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110]),
    (b'C', [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110]),
    (b'D', [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110]),
    (b'E', [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111]),
    (b'F', [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000]),
    (b'G', [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111]),
    (b'H', [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001]),
    (b'J', [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100]),
    (b'K', [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001]),
    (b'L', [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111]),
    (b'M', [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001]),
    (b'N', [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001]),
    (b'P', [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000]),
    (b'Q', [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101]),
    (b'R', [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001]),
    (b'S', [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110]),
    (b'T', [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100]),
    (b'U', [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110]),
    (b'V', [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100]),
    (b'W', [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001]),
    (b'X', [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001]),
    (b'Y', [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100]),
    (b'Z', [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111]),
    (b'2', [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111]),
    (b'3', [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110]),
    (b'4', [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010]),
    (b'5', [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110]),
    (b'6', [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110]),
    (b'7', [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000]),
    (b'8', [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110]),
    (b'9', [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100]),
];

fn glyph_rows(ch: char) -> [u8; 7] {
    GLYPHS.iter().find(|entry| entry.0 == ch as u8).map(|entry| entry.1).unwrap_or([0b11111; 7])
}

/// Minimal PNG encoder: 8-bit truecolor, filter type 0, zlib "stored" blocks.
/// The images are ~10 KB, so spending no CPU on compression is the right trade
/// and it keeps the encoder small enough to review at a glance.
fn encode_png(width: usize, height: usize, rgb: &[u8]) -> Vec<u8> {
    let stride = width * 3;
    let mut raw = Vec::with_capacity(height * (stride + 1));
    for row in 0..height {
        raw.push(0);
        raw.extend_from_slice(&rgb[row * stride..(row + 1) * stride]);
    }

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(width as u32).to_be_bytes());
    header.extend_from_slice(&(height as u32).to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]);
    write_chunk(&mut png, b"IHDR", &header);
    write_chunk(&mut png, b"IDAT", &zlib_stored(&raw));
    write_chunk(&mut png, b"IEND", &[]);
    png
}

fn write_chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let crc_start = png.len();
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let crc = crc32(&png[crc_start..]);
    png.extend_from_slice(&crc.to_be_bytes());
}

fn zlib_stored(data: &[u8]) -> Vec<u8> {
    // CMF/FLG: deflate, 32 KiB window, no preset dictionary, fastest level.
    let mut out = vec![0x78, 0x01];
    if data.is_empty() {
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xFF, 0xFF]);
    }
    let mut chunks = data.chunks(0xFFFF).peekable();
    while let Some(chunk) = chunks.next() {
        out.push(u8::from(chunks.peek().is_none()));
        let len = chunk.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut low, mut high) = (1u32, 0u32);
    for byte in data {
        low = (low + u32::from(*byte)) % 65521;
        high = (high + low) % 65521;
    }
    (high << 16) | low
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored_payload(zlib: &[u8]) -> Vec<u8> {
        let mut offset = 2; // CMF + FLG
        let mut out = Vec::new();
        loop {
            let header = zlib[offset];
            let len = u16::from_le_bytes([zlib[offset + 1], zlib[offset + 2]]) as usize;
            out.extend_from_slice(&zlib[offset + 5..offset + 5 + len]);
            offset += 5 + len;
            if header & 1 == 1 {
                break;
            }
        }
        out
    }

    #[test]
    fn captcha_mode_parses_and_fails_closed() {
        assert_eq!(CaptchaMode::parse(""), CaptchaMode::Auto);
        assert_eq!(CaptchaMode::parse(" always "), CaptchaMode::Always);
        assert_eq!(CaptchaMode::parse("AUTO"), CaptchaMode::Auto);
        assert_eq!(CaptchaMode::parse("off"), CaptchaMode::Off);
        assert_eq!(CaptchaMode::parse("0"), CaptchaMode::Off);
        // A typo must not silently disable protection.
        assert_eq!(CaptchaMode::parse("some-times"), CaptchaMode::Always);
    }

    #[test]
    fn user_input_accepts_only_the_three_modes() {
        assert_eq!(CaptchaMode::from_user_input("always"), Some(CaptchaMode::Always));
        assert_eq!(CaptchaMode::from_user_input(" Auto "), Some(CaptchaMode::Auto));
        assert_eq!(CaptchaMode::from_user_input("off"), Some(CaptchaMode::Off));
        assert_eq!(CaptchaMode::from_user_input("sometimes"), None);
        assert_eq!(CaptchaMode::from_user_input(""), None);
    }

    #[test]
    fn auto_only_challenges_after_a_failed_attempt() {
        assert!(CaptchaMode::Always.requires_challenge(0));
        assert!(CaptchaMode::Always.requires_challenge(3));
        assert!(!CaptchaMode::Auto.requires_challenge(0));
        assert!(CaptchaMode::Auto.requires_challenge(1));
        assert!(!CaptchaMode::Off.requires_challenge(0));
        assert!(!CaptchaMode::Off.requires_challenge(5));
    }

    #[test]
    fn issues_a_truecolor_png_of_the_fixed_size() {
        let store = CaptchaStore::new();
        let (_id, png) = store.issue();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(u32::from_be_bytes([png[16], png[17], png[18], png[19]]) as usize, WIDTH);
        assert_eq!(u32::from_be_bytes([png[20], png[21], png[22], png[23]]) as usize, HEIGHT);
        assert_eq!([png[24], png[25], png[26], png[27], png[28]], [8, 2, 0, 0, 0]);
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
    }

    #[test]
    fn the_paper_stays_light_so_the_glyphs_carry_the_challenge() {
        let rgb = render_rgb("ABCDE", &[9u8; 27]);
        let total = WIDTH * HEIGHT;
        let dark = rgb
            .chunks_exact(3)
            .filter(|pixel| u32::from(pixel[0]) + u32::from(pixel[1]) + u32::from(pixel[2]) < 300)
            .count();
        // Only the five glyphs (plus their darker core) may be dark; anything
        // more means the background wrapped or the noise overwhelmed the text.
        assert!(dark < total / 6, "{dark} of {total} pixels are dark");
    }

    #[test]
    fn stored_deflate_round_trips_and_keeps_the_adler_checksum() {
        let raw: Vec<u8> = (0..=255u8).cycle().take(70_000).collect();
        let zlib = zlib_stored(&raw);
        assert_eq!(stored_payload(&zlib), raw);
        assert_eq!(u32::from_be_bytes(zlib[zlib.len() - 4..].try_into().unwrap()), adler32(&raw));
    }

    #[test]
    fn codes_use_the_unambiguous_alphabet_and_unique_ids() {
        let store = CaptchaStore::new();
        let mut ids = std::collections::HashSet::new();
        for _ in 0..16 {
            let (id, _) = store.issue();
            assert!(ids.insert(id.clone()), "captcha ids must be unique");
            let code = store.code_of(&id).expect("challenge is pending");
            assert_eq!(code.len(), CODE_LEN);
            assert!(code.bytes().all(|byte| ALPHABET.contains(&byte)), "unexpected glyph in {code}");
        }
    }

    #[test]
    fn verification_accepts_any_case_once() {
        let store = CaptchaStore::new();
        let (id, _) = store.issue();
        let code = store.code_of(&id).unwrap();
        assert!(store.verify(&id, &format!(" {} ", code.to_lowercase())));
        assert!(!store.verify(&id, &code), "a challenge must not be reusable");
    }

    #[test]
    fn wrong_answer_consumes_the_challenge() {
        let store = CaptchaStore::new();
        let (id, _) = store.issue();
        let code = store.code_of(&id).unwrap();
        assert!(!store.verify(&id, "ZZZZZ"));
        assert!(!store.verify(&id, &code), "a failed attempt must burn the challenge");
        assert!(!store.verify("missing", &code));
    }

    #[test]
    fn expired_challenges_are_rejected() {
        let store = CaptchaStore::new();
        store.insert_for_test("old", "ABCDE", CAPTCHA_TTL + Duration::from_secs(1));
        assert!(!store.verify("old", "ABCDE"));
    }

    #[test]
    fn pending_challenges_stay_bounded() {
        let store = CaptchaStore::new();
        for _ in 0..MAX_PENDING + 8 {
            store.issue();
        }
        assert!(store.lock().len() <= MAX_PENDING, "captcha store must stay bounded");
    }
}

#[cfg(test)]
impl CaptchaStore {
    fn code_of(&self, id: &str) -> Option<String> {
        self.lock().get(id).map(|challenge| challenge.code.clone())
    }

    fn insert_for_test(&self, id: &str, code: &str, age: Duration) {
        self.lock().insert(id.to_string(), Challenge { code: code.to_string(), issued: Instant::now() - age });
    }
}
