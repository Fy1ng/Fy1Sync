use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
// Transient auto-learning model. Portable files use HudStylePack exclusively.
pub const CLOCK_CHARS: [&str; 11] = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ":"];
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RoiRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PreprocessSettings {
    pub scale: f64,
    pub threshold: f64,
    pub invert: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSample {
    pub id: String,
    pub data: String,
    pub created_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionProfile {
    pub id: String,
    pub name: String,
    pub roi: RoiRect,
    pub clock_format: String,
    pub detect_window_seconds: f64,
    pub sample_fps: f64,
    pub match_threshold: f64,
    pub preprocess: PreprocessSettings,
    pub templates: BTreeMap<String, Vec<TemplateSample>>,
    pub updated_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}
pub fn empty_profile(id: &str, name: &str) -> Value {
    json!({"id":id,"name":name,"roi":{"x":0.44,"y":0.02,"w":0.12,"h":0.07},"clockFormat":"m:ss","detectWindowSeconds":3,"sampleFps":30,"matchThreshold":0.82,"preprocess":{"scale":1.4,"threshold":150,"invert":false},"templates":{},"updatedAt":0,"notes":""})
}
pub fn profile_readiness(p: &RecognitionProfile) -> Value {
    let needed = &CLOCK_CHARS[..if p.clock_format == "ss" { 10 } else { 11 }];
    let missing: Vec<_> = needed
        .iter()
        .filter(|&&c| p.templates.get(c).map(Vec::is_empty).unwrap_or(true))
        .copied()
        .collect();
    json!({"ready":missing.is_empty(),"missing":missing,"sampleCount":p.templates.values().map(Vec::len).sum::<usize>()})
}
const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn pack_bitmap(mask: &[u8]) -> String {
    let mut bytes = vec![0u8; mask.len().div_ceil(8)];
    for (i, &n) in mask.iter().enumerate() {
        if n != 0 {
            bytes[i >> 3] |= 0x80 >> (i & 7);
        }
    }
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let v = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        out.push(ALPHABET[((v >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((v >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((v >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(v & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
pub fn unpack_bitmap(encoded: &str, count: usize) -> Result<Vec<u8>, String> {
    let clean = encoded.trim_end_matches(|c: char| crate::js_whitespace(c) || c == '=');
    let mut bytes = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for (i, c) in clean.chars().enumerate() {
        let Some(n) = ALPHABET.iter().position(|&v| v as char == c) else {
            return Err(format!(
                "invalid base64 character at {}",
                clean[..clean.char_indices().nth(i).map(|(n, _)| n).unwrap_or(0)]
                    .encode_utf16()
                    .count()
            ));
        };
        acc = (acc << 6) | (n as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((acc >> bits) & 255) as u8);
        }
    }
    if bytes.len() < count.div_ceil(8) {
        return Err(format!("bitmap too short: expected {count} pixels"));
    }
    Ok((0..count)
        .map(|i| {
            if bytes[i >> 3] & (0x80 >> (i & 7)) != 0 {
                255
            } else {
                0
            }
        })
        .collect())
}
pub fn count_ink(encoded: &str, count: usize) -> Result<usize, String> {
    Ok(unpack_bitmap(encoded, count)?
        .iter()
        .filter(|&&v| v != 0)
        .count())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codec_lengths() {
        for n in [0, 1, 5, 7, 8, 9, 17, 100, 1536] {
            let m: Vec<u8> = (0..n).map(|i| if i % 3 == 0 { 255 } else { 0 }).collect();
            assert_eq!(unpack_bitmap(&pack_bitmap(&m), n).unwrap(), m);
        }
    }
    #[test]
    fn codec_bytes() {
        assert_eq!(pack_bitmap(&[255, 0, 255, 255, 0, 0, 0, 0]), "sA==");
        assert_eq!(count_ink("sA==", 8).unwrap(), 3);
        assert!(unpack_bitmap("not*base64", 8)
            .unwrap_err()
            .contains("invalid base64"));
        assert!(unpack_bitmap("AA", 4096).is_err());
    }
    #[test]
    fn readiness() {
        let p: RecognitionProfile =
            serde_json::from_value(empty_profile("custom/test", "Test")).unwrap();
        assert_eq!(
            profile_readiness(&p)["missing"].as_array().unwrap().len(),
            11
        );
    }
}
