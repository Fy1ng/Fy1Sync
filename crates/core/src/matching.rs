use crate::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CompiledTemplates {
    pub chars: Vec<String>,
    pub masks: Vec<(String, Vec<Vec<u8>>)>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlyphMatch {
    pub char: Option<String>,
    pub score: f64,
    pub runner_up_score: f64,
    pub sample_index: isize,
}
pub fn score_masks(a: &[u8], b: &[u8]) -> f64 {
    let (mut inter, mut union) = (0usize, 0usize);
    for (&x, &y) in a.iter().zip(b) {
        if x != 0 && y != 0 {
            inter += 1;
        }
        if x != 0 || y != 0 {
            union += 1;
        }
    }
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}
pub fn score_coverage(a: &[u8], b: &[u8]) -> f64 {
    let (mut inter, mut union) = (0u64, 0u64);
    for (&x, &y) in a.iter().zip(b) {
        let y = if y != 0 { 255 } else { 0 };
        inter += x.min(y) as u64;
        union += x.max(y) as u64;
    }
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}
pub fn compile_templates(profile: &RecognitionProfile) -> CompiledTemplates {
    let mut chars = vec![];
    let mut masks = vec![];
    for c in CLOCK_CHARS {
        let Some(samples) = profile.templates.get(c) else {
            continue;
        };
        let unpacked: Vec<_> = samples
            .iter()
            .filter_map(|s| unpack_bitmap(&s.data, 1536).ok())
            .collect();
        if !unpacked.is_empty() {
            chars.push(c.to_string());
            masks.push((c.to_string(), unpacked));
        }
    }
    CompiledTemplates { chars, masks }
}
pub fn match_glyph(mask: &[u8], templates: &CompiledTemplates) -> GlyphMatch {
    let mut best = GlyphMatch {
        char: None,
        score: 0.0,
        runner_up_score: 0.0,
        sample_index: -1,
    };
    let mut runner = 0.0;
    for c in &templates.chars {
        let Some((_, samples)) = templates.masks.iter().find(|(k, _)| k == c) else {
            continue;
        };
        let (mut score, mut index) = (0.0, -1);
        for (i, s) in samples.iter().enumerate() {
            let n = score_coverage(mask, s);
            if n > score {
                score = n;
                index = i as isize;
            }
        }
        if score > best.score {
            runner = best.score;
            best = GlyphMatch {
                char: Some(c.clone()),
                score,
                runner_up_score: runner,
                sample_index: index,
            };
        } else if score > runner {
            runner = score;
        }
    }
    best.runner_up_score = runner;
    best
}
fn failure(reason: &str, detail: String) -> Value {
    json!({"status":"failed","reason":reason,"detail":detail})
}
pub fn recognize_frame(
    rgba: &[u8],
    width: usize,
    height: usize,
    profile: &RecognitionProfile,
    templates: &CompiledTemplates,
    meta: &Value,
    options: &Value,
) -> Value {
    let ready = profile_readiness(profile);
    if ready["ready"] != true {
        let missing = ready["missing"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s.as_str().unwrap())
            .collect::<Vec<_>>()
            .join(" ");
        return json!({"outcome":failure("insufficient-templates",format!("缺少字符模板：{missing}")),"debug":null});
    }
    let roi = roi_to_pixels(&profile.roi, width, height);
    let gray = to_grayscale(rgba, width, height);
    let binary = binarize(&crop_binary(&gray, &roi), &profile.preprocess);
    let ratio = ink_ratio(&binary);
    let seg = segment_glyphs(&binary, &options["segment"]);
    let mut debug = json!({"roiPixels":roi,"binary":binary,"boxes":seg.boxes,"projection":seg.projection,"inkRatio":ratio,"matches":[],"normalized":[]});
    if ratio < field_number(options, "minInkRatio", 0.004)
        || ratio > field_number(options, "maxInkRatio", 0.85)
    {
        return json!({"outcome":failure("blank-frame",format!("识别区域墨迹比例 {}%",js_to_fixed(ratio*100.0,1))),"debug":debug});
    }
    if seg.boxes.is_empty() {
        return json!({"outcome":failure("no-candidates","未切分出任何字符".into()),"debug":debug});
    }
    let mut scores = vec![];
    let mut text = String::new();
    let mut matches = Vec::new();
    let mut normalized = Vec::new();
    for b in &seg.boxes {
        let glyph = crop_binary(&binary, &b.rect());
        let cov = normalize_glyph_coverage(&glyph);
        let m = match_glyph(&cov, templates);
        normalized.push(threshold_coverage(&cov));
        matches.push(m.clone());
        debug["normalized"] = json!(normalized);
        debug["matches"] = json!(matches);
        let Some(c) = &m.char else {
            return json!({"outcome":failure("low-confidence","存在无法匹配的字符".into()),"debug":debug});
        };
        scores.push(m.score);
        text.push_str(c);
    }
    let confidence = scores.iter().copied().fold(1.0, f64::min);
    if confidence < profile.match_threshold {
        return json!({"outcome":failure("low-confidence",format!("最低字符得分 {} 低于阈值 {}",js_to_fixed(confidence,3),profile.match_threshold)),"debug":debug});
    }
    if let Some(m) = matches
        .iter()
        .find(|m| m.score - m.runner_up_score < field_number(options, "minMargin", 0.02))
    {
        return json!({"outcome":failure("low-confidence",format!("字符 {} 与次优候选过于接近",m.char.as_deref().unwrap_or("null"))),"debug":debug});
    }
    let Some(seconds) = parse_countdown(&text, &profile.clock_format) else {
        return json!({"outcome":failure("invalid-format",format!("识别结果 \"{text}\" 不符合 {}",profile.clock_format)),"debug":debug});
    };
    json!({"outcome":{"status":"success","reading":{"text":text,"seconds":seconds,"scores":scores,"confidence":confidence,"mediaTime":meta["mediaTime"],"wallTime":meta["wallTime"],"frameIndex":meta["frameIndex"]}},"debug":debug})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mask_scores() {
        assert_eq!(score_masks(&[255, 0, 255], &[255, 255, 0]), 1.0 / 3.0);
        assert_eq!(score_masks(&[0], &[0]), 0.0);
        assert_eq!(score_coverage(&[255, 0, 255], &[255, 255, 0]), 1.0 / 3.0);
        assert_eq!(score_coverage(&[128], &[255]), 128.0 / 255.0);
    }
    #[test]
    fn ties_and_empty() {
        let t = CompiledTemplates {
            chars: vec!["0".into(), "1".into()],
            masks: vec![("0".into(), vec![vec![255]]), ("1".into(), vec![vec![255]])],
        };
        let m = match_glyph(&[255], &t);
        assert_eq!(m.char.as_deref(), Some("0"));
        assert_eq!(m.runner_up_score, 1.0);
        assert_eq!(m.sample_index, 0);
        assert!(match_glyph(&[0], &t).char.is_none());
    }
    #[test]
    fn corrupt_compile() {
        let mut p: RecognitionProfile =
            serde_json::from_value(empty_profile("custom/test", "Test")).unwrap();
        p.templates.insert(
            "4".into(),
            vec![
                TemplateSample {
                    id: "bad".into(),
                    data: "!!!!".into(),
                    created_at: 0.0,
                    origin: None,
                },
                TemplateSample {
                    id: "good".into(),
                    data: pack_bitmap(&vec![255; 1536]),
                    created_at: 0.0,
                    origin: None,
                },
            ],
        );
        assert_eq!(compile_templates(&p).masks[0].1.len(), 1);
    }
    #[test]
    fn incomplete() {
        let p: RecognitionProfile =
            serde_json::from_value(empty_profile("custom/test", "Test")).unwrap();
        let r = recognize_frame(
            &[],
            0,
            0,
            &p,
            &compile_templates(&p),
            &Value::Null,
            &Value::Null,
        );
        assert_eq!(r["outcome"]["reason"], "insufficient-templates");
        assert!(r["debug"].is_null());
    }
    #[test]
    fn blank_and_flooded() {
        let mut p: RecognitionProfile =
            serde_json::from_value(empty_profile("custom/test", "Test")).unwrap();
        p.roi = RoiRect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        };
        for c in CLOCK_CHARS {
            p.templates.insert(
                c.into(),
                vec![TemplateSample {
                    id: c.into(),
                    data: pack_bitmap(&vec![255; 1536]),
                    created_at: 0.0,
                    origin: None,
                }],
            );
        }
        let t = compile_templates(&p);
        for pixels in [vec![0; 1600], vec![255; 1600]] {
            assert_eq!(
                recognize_frame(&pixels, 20, 20, &p, &t, &Value::Null, &Value::Null)["outcome"]
                    ["reason"],
                "blank-frame"
            );
        }
    }
}
