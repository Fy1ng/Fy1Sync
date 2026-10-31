#![forbid(unsafe_code)]
//! Deterministic, I/O-free ports of the TypeScript recognition and sync algorithms.

mod dispatch;
mod auto;
mod camera;
mod image;
mod matching;
mod hud;
mod profile;
mod temporal;

pub use dispatch::dispatch;
pub use auto::*;
pub use camera::*;
pub use image::*;
pub use matching::*;
pub use hud::*;
pub use profile::*;
use serde_json::{json, Value};
pub use temporal::*;

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
    pack: Option<HudStylePack>,
}
impl Engine {
    pub fn new() -> Self { Self::default() }
    pub fn configure(&mut self, pack_json: &str) -> Result<Value, String> {
        self.pack = None;
        let pack = hud_pack_from_json(pack_json)?;
        let readiness = hud_pack_readiness(&pack, &pack.variants[0].id);
        self.pack = Some(pack);
        Ok(readiness)
    }
    pub fn recognize(&self, rgba: &[u8], width: usize, height: usize,
        media_time: f64, wall_time: f64, frame_index: f64, want_debug: bool) -> Value {
        let Some(pack) = &self.pack else {
            return json!({"outcome":{"status":"failed","reason":"no-profile"},"debug":null});
        };
        match recognize_hud_frame(rgba,width,height,pack,&pack.variants[0].id) {
            Ok(result) => {
                let (outcome,debug) = match result.fields.clock {
                    HudFieldResult::Read{reading,debug} => (json!({"status":"success","reading":{
                        "text":reading.text,"seconds":reading.value,"scores":reading.scores,"confidence":reading.confidence,
                        "mediaTime":media_time,"wallTime":wall_time,"frameIndex":frame_index}}),debug),
                    HudFieldResult::Failed{reason,debug} => (json!({"status":"failed","reason":reason}),debug),
                    HudFieldResult::Absent{debug} => (json!({"status":"absent"}),debug),
                    HudFieldResult::Indeterminate{reason,debug} => (json!({"status":"indeterminate","reason":reason}),debug),
                };
                json!({"outcome":outcome,"debug":if want_debug {serde_json::to_value(debug).unwrap()}else{Value::Null}})
            },
            Err(error) => json!({"outcome":{"status":"failed","reason":"decode-failed","detail":error},"debug":null}),
        }
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
