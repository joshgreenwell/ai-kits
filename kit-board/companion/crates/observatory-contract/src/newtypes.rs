//! Validated scalar types. Each one rejects an out-of-contract value at
//! deserialization, so a record that reaches an adapter or the sink is already
//! well-formed field by field.

use std::fmt;
use std::ops::Deref;
use std::str::FromStr;

use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// The largest integer the server accepts (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ValueError {
    #[error("expected 64 lowercase hexadecimal characters")]
    Sha256,
    #[error("expected an RFC 3339 timestamp with an offset")]
    Stamp,
    #[error("expected a non-negative safe integer")]
    Counter,
    #[error("expected a code of 1 to 64 characters from [a-z0-9_.:-]")]
    Code,
    #[error("expected a meter key of 1 to 100 characters from [a-zA-Z0-9._:-]")]
    MeterKey,
    #[error("expected a tool name of 1 to 80 characters from [a-zA-Z0-9_.-] or h:<16 hex>")]
    ToolName,
    #[error("expected a decimal amount with at most 12 integer and 6 fractional digits")]
    Amount,
    #[error("expected an account id matching ^[a-z0-9][a-z0-9-]{{1,79}}$")]
    AccountId,
    #[error("expected between {min} and {max} characters")]
    Length { min: usize, max: usize },
    #[error("expected a hyphenated UUID")]
    Uuid,
    #[error("expected a finite number")]
    Real,
    #[error("expected the literal {0}")]
    Literal(u64),
}

const HEX: &[u8; 16] = b"0123456789abcdef";

fn is_lower_hex(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'a'..=b'f')
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

/// A lowercase SHA-256 hex digest.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Sha256Hex(String);

impl Sha256Hex {
    /// Hashes arbitrary bytes.
    pub fn digest(bytes: &[u8]) -> Self {
        let out = Sha256::digest(bytes);
        let mut text = String::with_capacity(64);
        for byte in out {
            text.push(HEX[usize::from(byte >> 4)] as char);
            text.push(HEX[usize::from(byte & 15)] as char);
        }
        Sha256Hex(text)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The first sixteen hex characters, used for hashed tool names (`h:<16 hex>`).
    pub fn prefix16(&self) -> &str {
        &self.0[..16]
    }
}

impl TryFrom<String> for Sha256Hex {
    type Error = ValueError;
    fn try_from(text: String) -> Result<Self, ValueError> {
        if text.len() == 64 && text.bytes().all(is_lower_hex) {
            Ok(Sha256Hex(text))
        } else {
            Err(ValueError::Sha256)
        }
    }
}

impl FromStr for Sha256Hex {
    type Err = ValueError;
    fn from_str(text: &str) -> Result<Self, ValueError> {
        Sha256Hex::try_from(text.to_owned())
    }
}

impl From<Sha256Hex> for String {
    fn from(value: Sha256Hex) -> String {
        value.0
    }
}

impl fmt::Debug for Sha256Hex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sha256Hex({})", self.0)
    }
}

impl fmt::Display for Sha256Hex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A hyphenated UUID as the server's `z.uuid()` accepts it: RFC 4122 variant with
/// version 1 through 8, or the nil or max UUID. The text is kept as given.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Uuid(String);

fn valid_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    if text == "00000000-0000-0000-0000-000000000000" || text == "ffffffff-ffff-ffff-ffff-ffffffffffff" {
        return true;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let ok = match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => matches!(byte, b'1'..=b'8'),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => is_hex(*byte),
        };
        if !ok {
            return false;
        }
    }
    true
}

impl Uuid {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// A random UUID (version 4).
    pub fn v4() -> Self {
        Uuid::from(uuid::Uuid::new_v4())
    }

    /// A name-based UUID (version 5) in the given namespace.
    pub fn v5(namespace: &uuid::Uuid, name: &[u8]) -> Self {
        Uuid::from(uuid::Uuid::new_v5(namespace, name))
    }
}

impl From<uuid::Uuid> for Uuid {
    fn from(value: uuid::Uuid) -> Self {
        Uuid(value.hyphenated().to_string())
    }
}

impl TryFrom<String> for Uuid {
    type Error = ValueError;
    fn try_from(text: String) -> Result<Self, ValueError> {
        if valid_uuid(&text) { Ok(Uuid(text)) } else { Err(ValueError::Uuid) }
    }
}

impl FromStr for Uuid {
    type Err = ValueError;
    fn from_str(text: &str) -> Result<Self, ValueError> {
        Uuid::try_from(text.to_owned())
    }
}

impl From<Uuid> for String {
    fn from(value: Uuid) -> String {
        value.0
    }
}

impl fmt::Debug for Uuid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Uuid({})", self.0)
    }
}

impl fmt::Display for Uuid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// An RFC 3339 timestamp with an explicit offset, exactly as the server's
/// `z.iso.datetime({ offset: true })` accepts it: `YYYY-MM-DDTHH:MM:SS`, optional
/// fraction, then `Z` or `±HH:MM`. The original text is preserved so a parsed
/// record re-serializes byte for byte.
#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Stamp {
    text: String,
    at: Timestamp,
}

fn valid_stamp_text(text: &str) -> bool {
    let b = text.as_bytes();
    let digit = |i: usize| b.get(i).is_some_and(u8::is_ascii_digit);
    let lit = |i: usize, c: u8| b.get(i) == Some(&c);
    let head = (0..4).all(digit)
        && lit(4, b'-')
        && digit(5)
        && digit(6)
        && lit(7, b'-')
        && digit(8)
        && digit(9)
        && lit(10, b'T')
        && digit(11)
        && digit(12)
        && lit(13, b':')
        && digit(14)
        && digit(15)
        && lit(16, b':')
        && digit(17)
        && digit(18);
    if !head {
        return false;
    }
    let mut i = 19;
    if lit(i, b'.') {
        i += 1;
        let start = i;
        while digit(i) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if lit(i, b'Z') {
        return i + 1 == b.len();
    }
    (lit(i, b'+') || lit(i, b'-'))
        && digit(i + 1)
        && digit(i + 2)
        && lit(i + 3, b':')
        && digit(i + 4)
        && digit(i + 5)
        && i + 6 == b.len()
}

impl Stamp {
    pub fn parse(text: &str) -> Result<Self, ValueError> {
        if !valid_stamp_text(text) {
            return Err(ValueError::Stamp);
        }
        let at = Timestamp::from_str(text).map_err(|_| ValueError::Stamp)?;
        Ok(Stamp { text: text.to_owned(), at })
    }

    /// Formats a timestamp as `YYYY-MM-DDTHH:MM:SS.mmmZ`, the shape v1 wrote.
    pub fn from_timestamp(at: Timestamp) -> Self {
        let zoned = at.to_zoned(TimeZone::UTC);
        let date = zoned.date();
        let time = zoned.time();
        let text = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            date.year(),
            date.month(),
            date.day(),
            time.hour(),
            time.minute(),
            time.second(),
            time.millisecond()
        );
        Stamp { text, at }
    }

    /// Formats whole milliseconds since the Unix epoch.
    pub fn from_millis(millis: i64) -> Result<Self, ValueError> {
        Timestamp::from_millisecond(millis).map(Stamp::from_timestamp).map_err(|_| ValueError::Stamp)
    }

    pub fn timestamp(&self) -> Timestamp {
        self.at
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }

    pub fn epoch_millis(&self) -> i64 {
        self.at.as_millisecond()
    }

    pub fn epoch_seconds(&self) -> i64 {
        self.at.as_second()
    }

    /// True when the instant lies on a UTC hour boundary.
    pub fn is_hour_boundary(&self) -> bool {
        self.at.as_millisecond().rem_euclid(3_600_000) == 0
    }

    /// True when this instant is later than `now` by more than the tolerance.
    pub fn is_future(&self, now: Timestamp, tolerance_seconds: i64) -> bool {
        self.at.as_second() > now.as_second().saturating_add(tolerance_seconds)
    }
}

impl PartialEq for Stamp {
    fn eq(&self, other: &Self) -> bool {
        self.text == other.text
    }
}

impl Eq for Stamp {}

impl std::hash::Hash for Stamp {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.text.hash(state);
    }
}

impl PartialOrd for Stamp {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Stamp {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.at.cmp(&other.at).then_with(|| self.text.cmp(&other.text))
    }
}

impl TryFrom<String> for Stamp {
    type Error = ValueError;
    fn try_from(text: String) -> Result<Self, ValueError> {
        Stamp::parse(&text)
    }
}

impl FromStr for Stamp {
    type Err = ValueError;
    fn from_str(text: &str) -> Result<Self, ValueError> {
        Stamp::parse(text)
    }
}

impl From<Stamp> for String {
    fn from(value: Stamp) -> String {
        value.text
    }
}

impl fmt::Debug for Stamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Stamp({})", self.text)
    }
}

impl fmt::Display for Stamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

/// A non-negative integer no larger than `Number.MAX_SAFE_INTEGER`.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
pub struct Counter(u64);

impl Counter {
    pub const ZERO: Counter = Counter(0);

    pub fn new(value: u64) -> Result<Self, ValueError> {
        if value <= MAX_SAFE_INTEGER { Ok(Counter(value)) } else { Err(ValueError::Counter) }
    }

    /// Clamps into range; use for measured local counters that cannot be negative.
    pub fn saturating(value: u64) -> Self {
        Counter(value.min(MAX_SAFE_INTEGER))
    }

    /// Converts a possibly negative measurement, clamping at zero and at the safe maximum.
    pub fn from_i64_clamped(value: i64) -> Self {
        Counter::saturating(u64::try_from(value).unwrap_or(0))
    }

    pub fn get(self) -> u64 {
        self.0
    }

    pub fn saturating_add(self, other: Counter) -> Counter {
        Counter::saturating(self.0.saturating_add(other.0))
    }

    pub fn max(self, other: Counter) -> Counter {
        Counter(self.0.max(other.0))
    }
}

impl TryFrom<u64> for Counter {
    type Error = ValueError;
    fn try_from(value: u64) -> Result<Self, ValueError> {
        Counter::new(value)
    }
}

impl From<Counter> for u64 {
    fn from(value: Counter) -> u64 {
        value.0
    }
}

impl fmt::Debug for Counter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl fmt::Display for Counter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

macro_rules! pattern_string {
    ($(#[$meta:meta])* $name:ident, $error:ident, $check:expr) => {
        $(#[$meta])*
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        pub struct $name(String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = ValueError;
            fn try_from(text: String) -> Result<Self, ValueError> {
                let check: fn(&str) -> bool = $check;
                if check(&text) { Ok($name(text)) } else { Err(ValueError::$error) }
            }
        }

        impl FromStr for $name {
            type Err = ValueError;
            fn from_str(text: &str) -> Result<Self, ValueError> {
                $name::try_from(text.to_owned())
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({})", stringify!($name), self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

fn code_byte(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b':' | b'-')
}

fn meter_byte(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'_' | b':' | b'-')
}

fn tool_byte(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'.' | b'-')
}

fn valid_amount(text: &str) -> bool {
    let rest = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match rest.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (rest, None),
    };
    let digits = |part: &str, min: usize, max: usize| {
        (min..=max).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit())
    };
    digits(whole, 1, 12) && fraction.is_none_or(|part| digits(part, 1, 6))
}

fn valid_account_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (2..=80).contains(&bytes.len())
        && matches!(bytes[0], b'a'..=b'z' | b'0'..=b'9')
        && bytes[1..].iter().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

pattern_string!(
    /// A bounded machine-readable code: `^[a-z0-9_.:-]{1,64}$`.
    Code,
    Code,
    |text| (1..=64).contains(&text.len()) && text.bytes().all(code_byte)
);

pattern_string!(
    /// An allowance meter key: `^[a-zA-Z0-9._:-]{1,100}$`, equal to the v1 `window_key`.
    MeterKey,
    MeterKey,
    |text| (1..=100).contains(&text.len()) && text.bytes().all(meter_byte)
);

pattern_string!(
    /// A tool name as written (`^[a-zA-Z0-9_.-]{1,80}$`) or hashed (`h:<16 hex>`).
    ToolName,
    ToolName,
    |text| match text.strip_prefix("h:") {
        Some(hash) => hash.len() == 16 && hash.bytes().all(is_lower_hex),
        None => (1..=80).contains(&text.len()) && text.bytes().all(tool_byte),
    }
);

pattern_string!(
    /// A decimal money amount as a string: `^-?\d{1,12}(\.\d{1,6})?$`.
    Amount,
    Amount,
    valid_amount
);

pattern_string!(
    /// A usage account id: `^[a-z0-9][a-z0-9-]{1,79}$`.
    AccountId,
    AccountId,
    valid_account_id
);

/// A string bounded by character count, `MIN..=MAX` code points.
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Text<const MIN: usize, const MAX: usize>(String);

impl<const MIN: usize, const MAX: usize> Text<MIN, MAX> {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Truncates to `MAX` code points; fails only when the result is shorter than `MIN`.
    pub fn truncated(text: &str) -> Result<Self, ValueError> {
        Text::try_from(text.chars().take(MAX).collect::<String>())
    }
}

impl<const MIN: usize, const MAX: usize> TryFrom<String> for Text<MIN, MAX> {
    type Error = ValueError;
    fn try_from(text: String) -> Result<Self, ValueError> {
        let count = text.chars().count();
        if (MIN..=MAX).contains(&count) {
            Ok(Text(text))
        } else {
            Err(ValueError::Length { min: MIN, max: MAX })
        }
    }
}

impl<const MIN: usize, const MAX: usize> FromStr for Text<MIN, MAX> {
    type Err = ValueError;
    fn from_str(text: &str) -> Result<Self, ValueError> {
        Text::try_from(text.to_owned())
    }
}

impl<const MIN: usize, const MAX: usize> From<Text<MIN, MAX>> for String {
    fn from(value: Text<MIN, MAX>) -> String {
        value.0
    }
}

impl<const MIN: usize, const MAX: usize> fmt::Debug for Text<MIN, MAX> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.0)
    }
}

impl<const MIN: usize, const MAX: usize> fmt::Display for Text<MIN, MAX> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A finite JSON number that keeps its integer-or-float spelling across a round trip.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "serde_json::Number", into = "serde_json::Number")]
pub struct Real(serde_json::Number);

impl Real {
    pub fn from_f64(value: f64) -> Result<Self, ValueError> {
        serde_json::Number::from_f64(value).map(Real).ok_or(ValueError::Real)
    }

    pub fn from_u64(value: u64) -> Self {
        Real(serde_json::Number::from(value))
    }

    pub fn as_f64(&self) -> f64 {
        self.0.as_f64().unwrap_or(f64::NAN)
    }

    pub fn number(&self) -> &serde_json::Number {
        &self.0
    }
}

impl TryFrom<serde_json::Number> for Real {
    type Error = ValueError;
    fn try_from(number: serde_json::Number) -> Result<Self, ValueError> {
        if number.as_f64().is_some_and(f64::is_finite) { Ok(Real(number)) } else { Err(ValueError::Real) }
    }
}

impl From<Real> for serde_json::Number {
    fn from(value: Real) -> serde_json::Number {
        value.0
    }
}

impl fmt::Debug for Real {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// A field that must be present and may be `null`. Unlike `Option`, a missing key
/// is an error, which is what the server's `.nullable()` (without `.optional()`) means.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Nullable<T>(pub Option<T>);

impl<T> Nullable<T> {
    pub const NULL: Nullable<T> = Nullable(None);

    pub fn some(value: T) -> Self {
        Nullable(Some(value))
    }

    pub fn as_ref(&self) -> Option<&T> {
        self.0.as_ref()
    }

    pub fn into_inner(self) -> Option<T> {
        self.0
    }
}

impl<T> From<Option<T>> for Nullable<T> {
    fn from(value: Option<T>) -> Self {
        Nullable(value)
    }
}

impl<T> Deref for Nullable<T> {
    type Target = Option<T>;
    fn deref(&self) -> &Option<T> {
        &self.0
    }
}

impl<T: Serialize> Serialize for Nullable<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl<'de, T: serde::de::DeserializeOwned> Deserialize<'de> for Nullable<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // `Option::deserialize` goes through `deserialize_option`, which serde's
        // missing-field path answers with `None`. Reading the raw value first makes a
        // missing key an error while `null` still becomes `None`.
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.is_null() {
            return Ok(Nullable(None));
        }
        T::deserialize(value).map(|inner| Nullable(Some(inner))).map_err(serde::de::Error::custom)
    }
}

impl<T: fmt::Debug> fmt::Debug for Nullable<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Some(value) => write!(f, "{value:?}"),
            None => f.write_str("null"),
        }
    }
}

/// A numeric literal, such as `schema_version: 2`.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Lit<const N: u64>;

impl<const N: u64> Serialize for Lit<N> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_u64(N)
    }
}

impl<'de, const N: u64> Deserialize<'de> for Lit<N> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = u64::deserialize(deserializer)?;
        if value == N { Ok(Lit) } else { Err(serde::de::Error::custom(ValueError::Literal(N))) }
    }
}

impl<const N: u64> fmt::Debug for Lit<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{N}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_accepts_the_server_shape_only() {
        for ok in [
            "2026-09-02T01:00:00Z",
            "2026-09-02T01:00:00.123Z",
            "2026-09-02T01:00:00+02:00",
            "2026-09-02T01:00:00.5-05:30",
        ] {
            assert!(Stamp::parse(ok).is_ok(), "{ok}");
        }
        for bad in [
            "2026-09-02 01:00:00Z",
            "2026-09-02T01:00Z",
            "2026-09-02T01:00:00",
            "2026-09-02t01:00:00z",
            "2026-13-02T01:00:00Z",
            "2026-09-02T01:00:00+0200",
            "2026-09-02T01:00:00.Z",
        ] {
            assert!(Stamp::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn stamp_formats_milliseconds_with_z() {
        let stamp = Stamp::from_millis(1_756_778_400_123).unwrap();
        assert_eq!(stamp.as_str(), "2025-09-02T02:00:00.123Z");
        assert!(!stamp.is_hour_boundary());
        assert!(Stamp::from_millis(1_756_778_400_000).unwrap().is_hour_boundary());
    }

    #[test]
    fn counter_rejects_unsafe_integers() {
        assert!(Counter::new(MAX_SAFE_INTEGER).is_ok());
        assert!(Counter::new(MAX_SAFE_INTEGER + 1).is_err());
        assert!(serde_json::from_str::<Counter>("-1").is_err());
        assert!(serde_json::from_str::<Counter>("1.5").is_err());
    }

    #[test]
    fn uuid_matches_the_server_pattern() {
        assert!(Uuid::from_str("123e4567-e89b-12d3-a456-426614174000").is_ok());
        assert!(Uuid::from_str("00000000-0000-0000-0000-000000000000").is_ok());
        assert!(Uuid::from_str("123e4567-e89b-02d3-a456-426614174000").is_err());
        assert!(Uuid::from_str("123e4567e89b12d3a456426614174000").is_err());
        assert!(Uuid::from_str(Uuid::v4().as_str()).is_ok());
    }

    #[test]
    fn patterns() {
        assert!(Code::from_str("cursor_usage_events").is_ok());
        assert!(Code::from_str("Bad").is_err());
        assert!(MeterKey::from_str("seven_day_claude_opus").is_ok());
        assert!(ToolName::from_str("h:0123456789abcdef").is_ok());
        assert!(ToolName::from_str("h:0123").is_err());
        assert!(Amount::from_str("-12.500000").is_ok());
        assert!(Amount::from_str("1234567890123").is_err());
        assert!(Amount::from_str("1.").is_err());
        assert!(AccountId::from_str("claude-primary").is_ok());
        assert!(AccountId::from_str("-x").is_err());
        assert!(Text::<1, 3>::from_str("").is_err());
        assert_eq!(Text::<0, 3>::truncated("abcdef").unwrap().as_str(), "abc");
    }

    #[test]
    fn nullable_requires_presence() {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Row {
            value: Nullable<Counter>,
        }
        assert!(serde_json::from_str::<Row>(r#"{"value":null}"#).unwrap().value.is_none());
        assert!(serde_json::from_str::<Row>(r#"{}"#).is_err());
    }

    #[test]
    fn literal() {
        assert!(serde_json::from_str::<Lit<2>>("2").is_ok());
        assert!(serde_json::from_str::<Lit<2>>("1").is_err());
        assert_eq!(serde_json::to_string(&Lit::<2>).unwrap(), "2");
    }
}
