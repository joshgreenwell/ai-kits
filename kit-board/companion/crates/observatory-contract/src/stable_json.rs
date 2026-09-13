//! `stableJson` from `kit-board/lib/contracts.ts`, reproduced for `content_hash`.
//!
//! The server serializes with `JSON.stringify` semantics (numbers as JavaScript
//! prints them, non-ASCII kept as is) and object keys sorted. Contract keys are
//! lowercase ASCII with underscores, for which JavaScript's `localeCompare` and
//! byte order agree, so `serde_json`'s ordered map is sufficient.

use serde_json::{Map, Number, Value};

use crate::newtypes::Sha256Hex;
use crate::records::{Dimensions, Record};

/// Serializes a value the way `stableJson` does.
pub fn stable_json(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&js_number(number)),
        Value::String(text) => write_js_string(text, out),
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
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_js_string(key, out);
                out.push(':');
                write_value(&map[*key], out);
            }
            out.push('}');
        }
    }
}

/// `JSON.stringify` string escaping: quotes, backslashes, and control characters
/// only; everything else is written as is.
pub fn write_js_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// The shortest decimal digits that round-trip `value` (which must be finite and
/// non-zero), with the position of the decimal point relative to the first digit.
/// `digits = "15", decpt = 1` means 1.5; `decpt = 3` means 150.
pub fn shortest_digits(value: f64) -> (bool, String, i32) {
    let negative = value.is_sign_negative();
    let text = format!("{:e}", value.abs());
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    (negative, digits, exponent + 1)
}

/// Formats a number as `JSON.stringify` does.
pub fn js_number(number: &Number) -> String {
    if let Some(unsigned) = number.as_u64() {
        return unsigned.to_string();
    }
    if let Some(signed) = number.as_i64() {
        return signed.to_string();
    }
    js_f64(number.as_f64().unwrap_or(0.0))
}

/// `Number.prototype.toString` for a finite double; `null` for non-finite values
/// (which `JSON.stringify` emits) and `0` for negative zero.
pub fn js_f64(value: f64) -> String {
    if !value.is_finite() {
        return "null".to_owned();
    }
    if value == 0.0 {
        return "0".to_owned();
    }
    let (negative, digits, n) = shortest_digits(value);
    let k = digits.len() as i32;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    if k <= n && n <= 21 {
        out.push_str(&digits);
        out.extend(std::iter::repeat_n('0', (n - k) as usize));
    } else if 0 < n && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat_n('0', (-n) as usize));
        out.push_str(&digits);
    } else {
        let exponent = n - 1;
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        out.push(if exponent >= 0 { '+' } else { '-' });
        out.push_str(&exponent.abs().to_string());
    }
    out
}

fn strip(map: &mut Map<String, Value>, keys: &[&str]) {
    for key in keys {
        map.remove(*key);
    }
}

/// `sha256(stableJson(record))` after removing `record_id`, `binding_id`,
/// `observed_at`, `parser_version`, and (for usage buckets)
/// `provider_refreshed_at`. The same measurement twice is a duplicate; a changed
/// measurement is a revision.
pub fn content_hash(record: &Record) -> serde_json::Result<Sha256Hex> {
    let mut value = serde_json::to_value(record)?;
    if let Value::Object(map) = &mut value {
        strip(map, &["record_id", "binding_id", "observed_at", "parser_version"]);
        if let Record::AccountUsageBucket(_) = record {
            strip(map, &["provider_refreshed_at"]);
        }
    }
    Ok(Sha256Hex::digest(stable_json(&value).as_bytes()))
}

/// `sha256(stableJson(dimensions))`, the scope key for a usage bucket revision.
pub fn dimensions_hash(dimensions: &Dimensions) -> serde_json::Result<Sha256Hex> {
    let value = serde_json::to_value(dimensions)?;
    Ok(Sha256Hex::digest(stable_json(&value).as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_print_like_javascript() {
        let cases: &[(f64, &str)] = &[
            (20.0, "20"),
            (20.5, "20.5"),
            (0.30000000000000004, "0.30000000000000004"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (123_456_789.123_456_79, "123456789.12345679"),
            (-0.0, "0"),
            (-1.5, "-1.5"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ];
        for (value, expected) in cases {
            assert_eq!(js_f64(*value), *expected, "{value}");
        }
        assert_eq!(js_number(&Number::from(7u64)), "7");
        assert_eq!(js_number(&Number::from(-7i64)), "-7");
    }

    #[test]
    fn sorts_keys_and_keeps_unicode() {
        let value = json!({"b": [1, {"z": null, "a": "é\n\"x\""}], "a": true});
        assert_eq!(stable_json(&value), r#"{"a":true,"b":[1,{"a":"é\n\"x\"","z":null}]}"#);
    }
}
