#![forbid(unsafe_code)]
//! Deterministic, I/O-free ports of the TypeScript recognition and sync algorithms.

mod dispatch;
mod auto;
mod camera;
mod image;
mod matching;
mod profile;
mod temporal;
mod score;

pub use dispatch::dispatch;
pub use auto::*;
pub use camera::*;
pub use image::*;
pub use matching::*;
pub use profile::*;
use serde_json::{json, Value};
pub use temporal::*;
pub use score::*;

/// JavaScript Math.round: ties go toward positive infinity, including negative zero.
pub fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value == 0.0 {
        return value;
    }
    if value >= -0.5 && value < 0.0 {
        return -0.0;
    }
    let lower = value.floor();
    if value - lower < 0.5 {
        lower
    } else {
        lower + 1.0
    }
}
pub fn round_millis(value: f64) -> f64 {
    js_round(value * 1000.0) / 1000.0
}
pub(crate) fn number(value: &Value) -> f64 {
    if let Some(n) = value.as_f64() {
        return n;
    }
    match value.get("$number").and_then(Value::as_str) {
        Some("NaN") => f64::NAN,
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        Some("-0") => -0.0,
        _ => f64::NAN,
    }
}
pub(crate) fn numeric(value: f64) -> Value {
    if value.is_nan() {
        json!({"$number":"NaN"})
    } else if value == f64::INFINITY {
        json!({"$number":"Infinity"})
    } else if value == f64::NEG_INFINITY {
        json!({"$number":"-Infinity"})
    } else {
        json!(value)
    }
}
pub(crate) fn field_number(value: &Value, key: &str, fallback: f64) -> f64 {
    value
        .get(key)
        .filter(|v| !v.is_null())
        .map(number)
        .unwrap_or(fallback)
}

#[derive(Default)]
pub struct Engine {
    profile: Option<RecognitionProfile>,
    templates: Option<CompiledTemplates>,
}
impl Engine {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn configure(&mut self, profile_json: &str) -> Result<Value, String> {
        let profile: RecognitionProfile =
            serde_json::from_str(profile_json).map_err(|e| e.to_string())?;
        let readiness = profile_readiness(&profile);
        self.templates = Some(compile_templates(&profile));
        self.profile = Some(profile);
        Ok(readiness)
    }
    pub fn recognize(
        &self,
        rgba: &[u8],
        width: usize,
        height: usize,
        media_time: f64,
        wall_time: f64,
        frame_index: f64,
        want_debug: bool,
    ) -> Value {
        let (Some(profile), Some(templates)) = (&self.profile, &self.templates) else {
            return json!({"outcome":{"status":"failed","reason":"no-profile"},"debug":null});
        };
        if rgba.len() < width.saturating_mul(height).saturating_mul(4) {
            return json!({"outcome":{"status":"failed","reason":"decode-failed","detail":"帧数据长度不足"},"debug":null});
        }
        let mut result = recognize_frame(
            rgba,
            width,
            height,
            profile,
            templates,
            &json!({"mediaTime":media_time,"wallTime":wall_time,"frameIndex":frame_index}),
            &Value::Null,
        );
        if !want_debug {
            result["debug"] = Value::Null;
        }
        result
    }
}

/// ECMAScript toFixed for the small decimal precisions used in diagnostics.
/// Round the exact IEEE-754 value, not a pre-rounded scaled binary float.
pub fn js_to_fixed(value: f64, digits: usize) -> String {
    if !value.is_finite() {
        return if value.is_nan() {
            "NaN".into()
        } else if value < 0.0 {
            "-Infinity".into()
        } else {
            "Infinity".into()
        };
    }
    if value.abs() >= 1e21 {
        return value.to_string();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    let raw = value.abs().to_bits();
    let exp = ((raw >> 52) & 2047) as i32;
    let frac = raw & ((1u64 << 52) - 1);
    let mant = if exp == 0 { frac } else { frac | (1u64 << 52) };
    let shift = if exp == 0 { -1074 } else { exp - 1023 - 52 };
    let numerator = (mant as u128) * 10u128.pow(digits as u32);
    let integer = if shift >= 0 {
        numerator.checked_shl(shift as u32).unwrap_or(0)
    } else {
        let bits = (-shift) as u32;
        if bits >= 128 {
            0
        } else {
            let denominator = 1u128 << bits;
            let q = numerator / denominator;
            let r = numerator % denominator;
            q + u128::from(r >= denominator - r)
        }
    };
    if digits == 0 {
        return format!("{sign}{integer}");
    }
    let base = 10u128.pow(digits as u32);
    format!(
        "{sign}{}.{:0width$}",
        integer / base,
        integer % base,
        width = digits
    )
}

pub(crate) fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() && b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if a > b {
        a
    } else {
        b
    }
}
pub(crate) fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if a < b {
        a
    } else {
        b
    }
}

pub(crate) fn js_whitespace(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
