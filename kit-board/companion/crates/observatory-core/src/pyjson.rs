//! Byte-exact reproductions of the Python primitives `collect.py` v1.1.0 uses,
//! so a v1 collector and the companion observing the same session produce the
//! same digests and therefore deduplicate in `token_bucket_revisions`.
//!
//! `py_compact_json` reproduces `json.dumps(value, sort_keys=True,
//! separators=(',', ':'))`: keys sorted by code point, no whitespace, non-ASCII
//! escaped as `\uXXXX`, integers without exponent, floats in Python `repr` form.

use std::str::FromStr;

use jiff::Timestamp;
use jiff::civil::{Date, DateTime};
use jiff::tz::TimeZone;
use observatory_contract::stable_json::shortest_digits;
use observatory_contract::{Sha256Hex, Stamp};
use serde_json::{Number, Value};

/// `json.dumps(value, sort_keys=True, separators=(',', ':'))`.
pub fn py_compact_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// `sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()`.
pub fn digest(value: &Value) -> Sha256Hex {
    Sha256Hex::digest(py_compact_json(value).as_bytes())
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&py_number(number)),
        Value::String(text) => write_py_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            // serde_json's map is ordered by byte order, which equals code point order.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_py_string(key, out);
                out.push(':');
                write_value(&map[*key], out);
            }
            out.push('}');
        }
    }
}

/// Python's `json` encoder with `ensure_ascii=True`.
fn write_py_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (' '..='~').contains(&c) => out.push(c),
            c => {
                let code = c as u32;
                if code > 0xFFFF {
                    let v = code - 0x10000;
                    out.push_str(&format!("\\u{:04x}\\u{:04x}", 0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF)));
                } else {
                    out.push_str(&format!("\\u{code:04x}"));
                }
            }
        }
    }
    out.push('"');
}

/// A JSON number as Python's encoder prints it.
pub fn py_number(number: &Number) -> String {
    if let Some(unsigned) = number.as_u64() {
        return unsigned.to_string();
    }
    if let Some(signed) = number.as_i64() {
        return signed.to_string();
    }
    py_float_repr(number.as_f64().unwrap_or(0.0))
}

/// Python `repr(float)`: shortest round-trip digits, fixed notation for
/// decimal exponents in `-4..=16`, otherwise `d.ddde±XX`.
pub fn py_float_repr(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity".to_owned() } else { "-Infinity".to_owned() };
    }
    if value == 0.0 {
        return if value.is_sign_negative() { "-0.0".to_owned() } else { "0.0".to_owned() };
    }
    let (negative, digits, decpt) = shortest_digits(value);
    let ndigits = digits.len() as i32;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if decpt > 16 || decpt <= -4 {
        let exponent = decpt - 1;
        out.push_str(&digits[..1]);
        if ndigits > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if exponent >= 0 { '+' } else { '-' });
        out.push_str(&format!("{:02}", exponent.abs()));
    } else if decpt <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-decpt) as usize));
        out.push_str(&digits);
    } else if decpt >= ndigits {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (decpt - ndigits) as usize));
        out.push_str(".0");
    } else {
        out.push_str(&digits[..decpt as usize]);
        out.push('.');
        out.push_str(&digits[decpt as usize..]);
    }
    out
}

/// Python truthiness of a JSON value.
pub fn py_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// Python `str(value)` for a JSON value: the string itself, else its `repr`.
pub fn py_str(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => py_repr(other),
    }
}

/// Python `repr(value)` for the JSON types (`None`, `True`, `[1, 'a']`, `{'k': 1}`).
pub fn py_repr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        Value::Number(n) => py_number(n),
        Value::String(s) => py_str_repr(s),
        Value::Array(items) => format!("[{}]", items.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(k, v)| format!("{}: {}", py_str_repr(k), py_repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

fn py_str_repr(text: &str) -> String {
    let quote = if text.contains('\'') && !text.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(quote);
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == quote => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7f => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(quote);
    out
}

/// `int(value) if isinstance(value, (int, float)) and value >= 0 else 0`.
/// Python booleans are integers, so `true` counts as 1.
pub fn count(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Bool(true)) => 1,
        Some(Value::Number(n)) => {
            if let Some(u) = n.as_u64() {
                i64::try_from(u).unwrap_or(i64::MAX)
            } else if let Some(i) = n.as_i64() {
                if i >= 0 { i } else { 0 }
            } else {
                let f = n.as_f64().unwrap_or(0.0);
                if f >= 0.0 { f.trunc().clamp(0.0, i64::MAX as f64) as i64 } else { 0 }
            }
        }
        _ => 0,
    }
}

/// The millisecond timestamp of a UUID version 7 as float seconds; `None` when
/// the value is not a string with `7` at index 14 or its first 48 bits are not hex.
pub fn uuid_time(value: Option<&Value>) -> Option<f64> {
    let text = value?.as_str()?;
    if text.chars().nth(14) != Some('7') {
        return None;
    }
    let hex: String = text.chars().filter(|c| *c != '-').take(12).collect();
    if hex.chars().count() != 12 {
        return None;
    }
    u64::from_str_radix(&hex, 16).ok().map(|ms| ms as f64 / 1000.0)
}

/// `datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()`; `None` on any failure.
pub fn epoch(value: Option<&Value>) -> Option<f64> {
    epoch_text(value?.as_str()?)
}

/// `epoch` for a string.
pub fn epoch_text(text: &str) -> Option<f64> {
    let normalized = text.replace('Z', "+00:00");
    if let Ok(at) = Timestamp::from_str(&normalized) {
        return Some(micros_to_seconds(at.as_microsecond()));
    }
    if let Ok(naive) = DateTime::from_str(&normalized) {
        let zoned = naive.to_zoned(TimeZone::system()).ok()?;
        return Some(micros_to_seconds(zoned.timestamp().as_microsecond()));
    }
    if let Ok(date) = Date::from_str(&normalized) {
        let zoned = date.to_zoned(TimeZone::system()).ok()?;
        return Some(micros_to_seconds(zoned.timestamp().as_microsecond()));
    }
    None
}

/// `timedelta.total_seconds()`: one division of the integer microsecond total.
fn micros_to_seconds(micros: i64) -> f64 {
    micros as f64 / 1e6
}

/// `int(timestamp // 3600) * 3600` as whole seconds.
pub fn hour_floor(seconds: f64) -> i64 {
    (seconds / 3600.0).floor() as i64 * 3600
}

/// `datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')`.
pub fn iso(seconds: f64) -> Option<Stamp> {
    let whole = seconds.trunc();
    let fraction = seconds - whole;
    let mut second = whole as i64;
    let mut micros = (fraction * 1e6).round_ties_even() as i64;
    if micros >= 1_000_000 {
        second += 1;
        micros -= 1_000_000;
    } else if micros < 0 {
        second -= 1;
        micros += 1_000_000;
    }
    let nanos = i32::try_from(micros * 1000).ok()?;
    Timestamp::new(second, nanos).ok().map(Stamp::from_timestamp)
}

/// `iso()` for a clock reading.
pub fn iso_now(now: Timestamp) -> Stamp {
    Stamp::from_timestamp(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compact_json_matches_python() {
        let value = json!({"b": 1.5, "a": "é", "c": [1, 2.0, 1e21, true, null]});
        assert_eq!(py_compact_json(&value), r#"{"a":"\u00e9","b":1.5,"c":[1,2.0,1e+21,true,null]}"#);
        let value = json!({"k": "é中😀\u{7f}\u{1}\t\"\\/"});
        assert_eq!(py_compact_json(&value), r#"{"k":"\u00e9\u4e2d\ud83d\ude00\u007f\u0001\t\"\\/"}"#);
    }

    #[test]
    fn float_repr_matches_python() {
        let cases: &[(f64, &str)] = &[
            (1e16, "1e+16"),
            (1e15, "1000000000000000.0"),
            (0.30000000000000004, "0.30000000000000004"),
            (1e-5, "1e-05"),
            (0.0001, "0.0001"),
            (123_456_789.123_456_79, "123456789.12345679"),
            (1e21, "1e+21"),
            (5e-324, "5e-324"),
            (1.0, "1.0"),
            (-0.0, "-0.0"),
            (20.0, "20.0"),
            (2.5e-7, "2.5e-07"),
            (1234567890123456.0, "1234567890123456.0"),
            (12345678901234567.0, "1.2345678901234568e+16"),
            (0.5, "0.5"),
            (100.0, "100.0"),
            (1e300, "1e+300"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (9_007_199_254_740_992.0, "9007199254740992.0"),
            (0.000123, "0.000123"),
        ];
        for (value, expected) in cases {
            assert_eq!(py_float_repr(*value), *expected, "{value}");
        }
    }

    #[test]
    fn str_and_repr() {
        assert_eq!(py_str(&json!(1234567890123u64)), "1234567890123");
        assert_eq!(py_str(&json!(true)), "True");
        assert_eq!(py_str(&json!(2.0)), "2.0");
        assert_eq!(py_str(&json!([1, "a", null, true])), "[1, 'a', None, True]");
        assert_eq!(py_str(&json!({"a": 1, "b": "x"})), "{'a': 1, 'b': 'x'}");
        assert_eq!(py_str(&json!("it's")), "it's");
        assert_eq!(py_repr(&json!("it's")), "\"it's\"");
    }

    #[test]
    fn digest_matches_collect_py() {
        // sha256 of '["codex","main","s"]' as Python computes it.
        assert_eq!(
            digest(&json!(["codex", "main", "s"])).as_str(),
            Sha256Hex::digest(br#"["codex","main","s"]"#).as_str()
        );
    }

    #[test]
    fn time_helpers() {
        assert_eq!(iso(1_756_778_400.123_5).unwrap().as_str(), "2025-09-02T02:00:00.123Z");
        assert_eq!(iso(1_756_778_400.999_999_6_f64).unwrap().as_str(), "2025-09-02T02:00:01.000Z");
        assert_eq!(iso(1_756_778_400.000_5).unwrap().as_str(), "2025-09-02T02:00:00.000Z");
        assert_eq!(iso(1_756_778_400.000_4).unwrap().as_str(), "2025-09-02T02:00:00.000Z");
        assert_eq!(epoch_text("2026-09-02T01:00:00Z"), Some(1_788_310_800.0));
        assert_eq!(epoch_text("2026-09-02T01:00:00.123Z"), Some(1_788_310_800.123));
        assert_eq!(epoch_text("2026-09-02T03:00:00+02:00"), Some(1_788_310_800.0));
        assert_eq!(epoch_text("nonsense"), None);
        assert_eq!(epoch(Some(&json!(12))), None);
        assert_eq!(hour_floor(1_788_310_800.9 + 1800.0), 1_788_310_800);
        assert_eq!(uuid_time(Some(&json!("0199155c-6200-7c1e-9c9a-000000000000"))), Some(1_757_000_000.0));
        assert_eq!(uuid_time(Some(&json!("0199155c-6200-4c1e-9c9a-000000000000"))), None);
        assert_eq!(uuid_time(Some(&json!(7))), None);
        assert_eq!(count(Some(&json!(2.7))), 2);
        assert_eq!(count(Some(&json!(-3))), 0);
        assert_eq!(count(Some(&json!(true))), 1);
        assert_eq!(count(Some(&json!("5"))), 0);
        assert_eq!(count(None), 0);
        assert!(py_truthy(&json!({"a": 1})));
        assert!(!py_truthy(&json!({})));
        assert!(!py_truthy(&json!(0.0)));
    }
}
