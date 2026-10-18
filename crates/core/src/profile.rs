use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
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
    pub schema_version: u32,
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
    json!({"schemaVersion":2,"id":id,"name":name,"roi":{"x":0.44,"y":0.02,"w":0.12,"h":0.07},"clockFormat":"m:ss","detectWindowSeconds":3,"sampleFps":30,"matchThreshold":0.82,"preprocess":{"scale":1.4,"threshold":150,"invert":false},"templates":{},"updatedAt":0,"notes":""})
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
fn issue(issues: &mut Vec<Value>, path: &str, msg: &str, severity: &str) {
    issues.push(json!({"path":path,"message":msg,"severity":severity}));
}
fn fraction(v: &Value, key: &str, issues: &mut Vec<Value>) -> f64 {
    let n = crate::number(&v[key]);
    if !n.is_finite() {
        issue(issues, &format!("roi.{key}"), "必须是数字", "error");
        0.0
    } else {
        if !(0.0..=1.0).contains(&n) {
            issue(issues, &format!("roi.{key}"), "必须在 0 与 1 之间", "error");
        }
        n
    }
}
fn bounded(
    v: &Value,
    key: &str,
    min: f64,
    max: f64,
    fallback: f64,
    issues: &mut Vec<Value>,
) -> f64 {
    let Some(raw) = v.get(key) else {
        return fallback;
    };
    let n = crate::number(raw);
    if !n.is_finite() {
        issue(issues, key, "必须是数字", "error");
        fallback
    } else if n < min || n > max {
        issue(issues, key, &format!("必须在 {min} 与 {max} 之间"), "error");
        fallback
    } else {
        n
    }
}
pub fn validate_profile(v: &Value) -> Value {
    let mut issues = vec![];
    if !v.is_object() {
        return json!({"profile":null,"issues":[{"path":"","message":"配置必须是对象","severity":"error"}]});
    }
    let id = v["id"]
        .as_str()
        .unwrap_or("")
        .trim_matches(crate::js_whitespace);
    let valid = id.split('/').all(|part| {
        let mut chars = part.chars();
        chars
            .next()
            .map(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
            .unwrap_or(false)
            && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
    });
    if !valid {
        issue(
            &mut issues,
            "id",
            "id 只能包含小写字母、数字、. _ - 和 /",
            "error",
        );
    }
    let name = v["name"]
        .as_str()
        .map(|s| s.trim_matches(crate::js_whitespace))
        .filter(|s| !s.is_empty())
        .unwrap_or(id);
    if name.is_empty() {
        issue(&mut issues, "name", "缺少名称", "error");
    }
    let roi = if v["roi"].is_object() {
        let r = &v["roi"];
        let x = fraction(r, "x", &mut issues);
        let y = fraction(r, "y", &mut issues);
        let w = fraction(r, "w", &mut issues);
        let h = fraction(r, "h", &mut issues);
        if w <= 0.0 || h <= 0.0 {
            issue(&mut issues, "roi", "识别区域宽高必须大于 0", "error");
        }
        if x + w > 1.0001 || y + h > 1.0001 {
            issue(&mut issues, "roi", "识别区域超出画面范围", "error");
        }
        json!({"x":x,"y":y,"w":w,"h":h})
    } else {
        issue(&mut issues, "roi", "缺少识别区域", "error");
        json!({"x":0,"y":0,"w":0,"h":0})
    };
    let preprocess = if v["preprocess"].is_object() {
        let p = &v["preprocess"];
        let mut scale = crate::number(&p["scale"]);
        if scale <= 0.0 {
            scale = f64::NAN;
        }
        if !scale.is_finite() {
            issue(&mut issues, "preprocess.scale", "对比度必须大于 0", "error");
        }
        let threshold = crate::number(&p["threshold"]);
        if !threshold.is_finite() || !(0.0..=255.0).contains(&threshold) {
            issue(
                &mut issues,
                "preprocess.threshold",
                "阈值必须在 0-255 之间",
                "error",
            );
        }
        json!({"scale":if scale.is_finite(){scale}else{1.4},"threshold":if threshold.is_finite(){threshold}else{150.0},"invert":p["invert"]==true})
    } else {
        issue(
            &mut issues,
            "preprocess",
            "缺少预处理参数，已使用默认值",
            "warning",
        );
        json!({"scale":1.4,"threshold":150,"invert":false})
    };
    let format = v["clockFormat"]
        .as_str()
        .filter(|s| ["m:ss", "mm:ss", "ss", "auto"].contains(s))
        .unwrap_or("m:ss");
    if v.get("clockFormat").is_some()
        && !matches!(
            v["clockFormat"].as_str(),
            Some("m:ss" | "mm:ss" | "ss" | "auto")
        )
    {
        issue(
            &mut issues,
            "clockFormat",
            "未知时钟格式，已回退到 m:ss",
            "warning",
        );
    }
    let window = bounded(v, "detectWindowSeconds", 1.0, 10.0, 3.0, &mut issues);
    let fps = bounded(v, "sampleFps", 1.0, 60.0, 30.0, &mut issues);
    let threshold = bounded(v, "matchThreshold", 0.1, 1.0, 0.82, &mut issues);
    let mut templates = serde_json::Map::new();
    if let Some(raw) = v.get("templates") {
        if let Some(map) = raw.as_object() {
            for (c, samples) in map {
                let p = format!("templates.{c}");
                if !CLOCK_CHARS.contains(&c.as_str()) {
                    issue(&mut issues, &p, "不支持的字符，已忽略", "warning");
                    continue;
                }
                let Some(samples) = samples.as_array() else {
                    issue(&mut issues, &p, "必须是样本数组", "error");
                    continue;
                };
                let mut parsed = vec![];
                for (i, s) in samples.iter().enumerate() {
                    let sp = format!("{p}[{i}]");
                    let Some(data) = s["data"].as_str().filter(|s| !s.is_empty()) else {
                        issue(&mut issues, &sp, "样本缺少位图数据", "error");
                        continue;
                    };
                    if data.encode_utf16().count() < 256 {
                        issue(&mut issues, &sp, "位图数据长度不足", "error");
                        continue;
                    }
                    let sid = s["id"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("{c}-{i}"));
                    let mut sample = json!({"id":sid,"data":data,"createdAt":s["createdAt"].as_f64().unwrap_or(0.0)});
                    if let Some(origin) = s["origin"].as_str() {
                        sample["origin"] = json!(origin);
                    }
                    parsed.push(sample);
                }
                if !parsed.is_empty() {
                    templates.insert(c.clone(), json!(parsed));
                }
            }
        } else {
            issue(&mut issues, "templates", "模板必须是对象", "error");
        }
    }
    if issues.iter().any(|i| i["severity"] == "error") {
        return json!({"profile":null,"issues":issues});
    }
    let mut p = json!({"schemaVersion":2,"id":id,"name":name,"roi":roi,"clockFormat":format,"detectWindowSeconds":window,"sampleFps":fps,"matchThreshold":threshold,"preprocess":preprocess,"templates":templates,"updatedAt":v["updatedAt"].as_f64().unwrap_or(0.0)});
    if let Some(notes) = v["notes"].as_str() {
        p["notes"] = json!(notes);
    }
    json!({"profile":p,"issues":issues})
}
pub fn parse_profile(v: &Value) -> Value {
    if !v.is_object() {
        return validate_profile(v);
    }
    let version = v["schemaVersion"].as_f64().unwrap_or(1.0);
    if version > 2.0 {
        return json!({"profile":null,"issues":[{"path":"schemaVersion","message":format!("配置版本 {version} 高于当前支持的 2，请升级应用"),"severity":"error"}]});
    }
    if version == 2.0 {
        return validate_profile(v);
    }
    let mut migrated = v.clone();
    migrated["schemaVersion"] = json!(2);
    let mut t = serde_json::Map::new();
    if let Some(raw) = v["templates"].as_object() {
        for (c, s) in raw {
            if s.is_array() {
                t.insert(c.clone(), s.clone());
            } else if let Some(data) = s["data"].as_str().or_else(|| s.as_str()) {
                t.insert(
                    c.clone(),
                    json!([{"id":format!("{c}-migrated"),"data":data,"createdAt":0,"origin":"v1"}]),
                );
            }
        }
    }
    migrated["templates"] = json!(t);
    if !v["preprocess"].is_object() {
        migrated["preprocess"] = json!({"scale":v["scale"].as_f64().unwrap_or(1.4),"threshold":v["threshold"].as_f64().unwrap_or(150.0),"invert":v["invert"]==true});
    }
    let mut result = validate_profile(&migrated);
    result["issues"].as_array_mut().unwrap().insert(0,json!({"path":"schemaVersion","message":"已从 v1 迁移到 v2（单模板转为样本数组）","severity":"warning"}));
    result
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
    fn validation() {
        let p = empty_profile("cs2/iem", "IEM");
        assert!(validate_profile(&p)["profile"].is_object());
        let mut bad = p.clone();
        bad["roi"]["w"] = json!(0);
        assert!(validate_profile(&bad)["profile"].is_null());
        bad = p.clone();
        bad["sampleFps"] = json!(240);
        assert!(validate_profile(&bad)["profile"].is_null());
        bad = p.clone();
        bad["id"] = json!("CS2 IEM");
        assert!(validate_profile(&bad)["profile"].is_null());
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
    #[test]
    fn migration_and_future() {
        assert_eq!(
            parse_profile(&json!({"schemaVersion":3}))["issues"][0]["path"],
            "schemaVersion"
        );
        assert!(parse_profile(&Value::Null)["profile"].is_null());
        let mut v = empty_profile("custom/test", "Test");
        v.as_object_mut().unwrap().remove("schemaVersion");
        assert_eq!(parse_profile(&v)["issues"][0]["severity"], "warning");
    }
}
