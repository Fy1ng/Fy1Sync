use crate::*;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
fn arg<'a>(input: &'a Value, index: usize, key: &str) -> &'a Value {
    if let Some(a) = input.as_array() {
        a.get(index).unwrap_or(&Value::Null)
    } else {
        input.get(key).unwrap_or(&Value::Null)
    }
}
fn n(input: &Value, index: usize, key: &str, default: f64) -> f64 {
    let v = arg(input, index, key);
    if v.is_null() {
        default
    } else {
        number(v)
    }
}
fn s<'a>(input: &'a Value, index: usize, key: &str, default: &'a str) -> &'a str {
    arg(input, index, key).as_str().unwrap_or(default)
}
fn de<T: DeserializeOwned>(v: &Value) -> Result<T, String> {
    serde_json::from_value(v.clone()).map_err(|e| e.to_string())
}
fn bytes(v: &Value) -> Result<Vec<u8>, String> {
    if let Some(array) = v.as_array() {
        Ok(array.iter().map(|v| number(v) as u8).collect())
    } else if let Some(map) = v.as_object() {
        let mut out = vec![];
        for i in 0..map.len() {
            out.push(number(&v[i.to_string()]) as u8);
        }
        Ok(out)
    } else {
        Err("expected byte array".into())
    }
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn normal_zero(v: &mut Value) {
    if v.get("$number").and_then(Value::as_str) == Some("-0") {
        *v = json!(-0.0);
    } else if let Some(a) = v.as_array_mut() {
        for n in a {
            normal_zero(n);
        }
    } else if let Some(o) = v.as_object_mut() {
        for n in o.values_mut() {
            normal_zero(n);
        }
    }
}
/// JSON operation bridge used by WASM, the CLI, and cross-language parity tests.
/// Input accepts TypeScript positional argument arrays or named parameter objects.
pub fn dispatch(op: &str, mut input: Value) -> Result<Value, String> {
    normal_zero(&mut input);
    let a = |i, k| arg(&input, i, k);
    let num = |i, k, d| n(&input, i, k, d);
    let text = |i, k, d| s(&input, i, k, d);
    Ok(match op {
        "contentRect" => json!(content_rect(
            num(0, "videoWidth", 0.0),
            num(1, "videoHeight", 0.0),
            num(2, "elementWidth", 0.0),
            num(3, "elementHeight", 0.0)
        )),
        "pointToFraction" => {
            let p = a(0, "point");
            let c: Rect = de(a(1, "content"))?;
            if c.width <= 0.0 || c.height <= 0.0 {
                json!({"x":0,"y":0})
            } else {
                json!({"x":clamp01((number(&p["x"])-c.x)/c.width),"y":clamp01((number(&p["y"])-c.y)/c.height)})
            }
        }
        "roiToPixels" => json!(roi_to_pixels(
            &de(a(0, "roi"))?,
            num(1, "frameWidth", 0.0) as usize,
            num(2, "frameHeight", 0.0) as usize
        )),
        "normalizeRoi" => json!(normalize_roi(&de(a(0, "roi"))?)),
        "toGrayscale" => json!(to_grayscale(
            &bytes(a(0, "rgba"))?,
            num(1, "width", 0.0) as usize,
            num(2, "height", 0.0) as usize
        )),
        "binarize" => json!(binarize(&de(a(0, "image"))?, &de(a(1, "settings"))?)),
        "inkRatio" => numeric(ink_ratio(&de(a(0, "image"))?)),
        "boundingBox" => json!(bounding_box(&de(a(0, "image"))?)),
        "cropBinary" => json!(crop_binary(&de(a(0, "image"))?, &de(a(1, "rect"))?)),
        "normalizeGlyphCoverage" => json!(normalize_glyph_coverage(&de(a(0, "glyph"))?)),
        "normalizeGlyph" => json!(normalize_glyph(&de(a(0, "glyph"))?)),
        "thresholdCoverage" => json!(threshold_coverage(&bytes(a(0, "coverage"))?)),
        "columnProjection" => json!(column_projection(&de(a(0, "image"))?)),
        "segmentGlyphs" => json!(segment_glyphs(&de(a(0, "image"))?, a(1, "options"))),
        "mergeGlyphBoxes" => json!(merge_glyph_boxes(
            &de::<Vec<GlyphBox>>(a(0, "boxes"))?,
            num(1, "from", 0.0) as isize,
            num(2, "to", 0.0) as isize
        )),
        "splitGlyphBox" => json!(split_glyph_box(
            &de::<Vec<GlyphBox>>(a(0, "boxes"))?,
            num(1, "index", -1.0) as isize as usize,
            num(2, "atX", 0.0)
        )),
        "excludeGlyphBox" => json!(exclude_glyph_box(
            &de::<Vec<GlyphBox>>(a(0, "boxes"))?,
            num(1, "index", -1.0) as isize as usize
        )),
        "adjustGlyphBox" => {
            let bounds = a(4, "bounds");
            json!(adjust_glyph_box(
                &de::<Vec<GlyphBox>>(a(0, "boxes"))?,
                num(1, "index", -1.0) as isize as usize,
                text(2, "edge", "bottom"),
                num(3, "delta", 0.0),
                number(&bounds["width"]),
                number(&bounds["height"])
            ))
        }
        "scoreMasks" => numeric(score_masks(&bytes(a(0, "a"))?, &bytes(a(1, "b"))?)),
        "scoreCoverage" => numeric(score_coverage(
            &bytes(a(0, "coverage"))?,
            &bytes(a(1, "template"))?,
        )),
        "compileTemplates" => json!(compile_templates(&de(a(0, "profile"))?)),
        "matchGlyph" => json!(match_glyph(&bytes(a(0, "mask"))?, &de(a(1, "templates"))?)),
        "recognizeFrame" => {
            let f = a(0, "frame");
            let p: RecognitionProfile = de(a(1, "profile"))?;
            let t = if a(2, "templates").is_null() {
                compile_templates(&p)
            } else {
                de(a(2, "templates"))?
            };
            recognize_frame(
                &bytes(&f["data"])?,
                number(&f["width"]) as usize,
                number(&f["height"]) as usize,
                &p,
                &t,
                a(3, "meta"),
                a(4, "options"),
            )
        }
        "packBitmap" => json!(pack_bitmap(&bytes(a(0, "mask"))?)),
        "unpackBitmap" | "countInk" => {
            let count = num(1, "pixelCount", f64::NAN);
            if !count.is_finite() || count < 0.0 || count.fract() != 0.0 {
                return Err(format!("invalid pixel count: {count}"));
            }
            let encoded = text(0, "encoded", "");
            if op == "countInk" {
                json!(count_ink(encoded, count as usize)?)
            } else {
                json!(unpack_bitmap(encoded, count as usize)?)
            }
        }
        "parseCountdown" => json!(parse_countdown(
            text(0, "text", ""),
            text(1, "format", "auto")
        )),
        "clockJump" | "clockJumpSequence" => {
            let value = if input.is_array() { &input[0] } else { &input };
            let mut d = ClockJumpDetector::new(
                value["source"].as_str().unwrap_or("official"),
                value["options"].clone(),
            );
            let mut results = vec![];
            if let Some(ops) = value["operations"].as_array() {
                for op in ops {
                    if op["type"] == "reset" {
                        d.reset();
                    } else {
                        results.push(d.push(op["outcome"].clone()));
                    }
                }
            } else {
                for out in arr(&value["outcomes"]) {
                    results.push(d.push(out.clone()));
                }
            }
            json!(results)
        }
        "clockAnchorMs" => numeric(clock_anchor_ms(a(0, "event"))),
        "median" => numeric(median(
            &arr(a(0, "values")).iter().map(number).collect::<Vec<_>>(),
        )),
        "estimateOffset" => estimate_offset(
            arr(a(0, "officialEvents")),
            arr(a(1, "commentaryEvents")),
            a(2, "options"),
        ),
        "clampOffset" => numeric(clamp_offset(
            num(0, "offset", f64::NAN),
            num(1, "max", 60.0),
        )),
        "rewindForOffset" => rewind_for_offset(num(0, "offset", f64::NAN)),
        "offsetFromRewind" => numeric(offset_from_rewind(a(0, "rewind"))),
        "seekableRange" => seekable_range(a(0, "timebase")),
        "availableRewind" => numeric(available_rewind(a(0, "snapshot"))),
        "planOffsetChange" => plan_offset_change(if input.is_array() {
            a(0, "input")
        } else {
            &input
        }),
        "planIsComplete" => json!(plan_is_complete(a(0, "plan"), num(1, "tolerance", 0.05))),
        "isAligned" => json!(is_aligned(
            num(0, "offset", f64::NAN),
            num(1, "deadband", 0.1)
        )),
        "describeOffset" => json!(describe_offset(
            num(0, "offset", f64::NAN),
            num(1, "deadband", 0.1)
        )),
        "snapOffset" => numeric(snap_offset(
            num(0, "value", f64::NAN),
            num(1, "step", f64::NAN),
        )),
        "createEmptyProfile" => empty_profile(
            text(0, "id", "custom/untitled"),
            text(1, "name", "未命名场景"),
        ),
        "validateProfile" => validate_profile(if input.is_array() {
            a(0, "value")
        } else {
            input.get("value").unwrap_or(&input)
        }),
        "parseProfile" => parse_profile(if input.is_array() {
            a(0, "value")
        } else {
            input.get("value").unwrap_or(&input)
        }),
        "profileReadiness" => profile_readiness(&de(a(0, "profile"))?),
        _ => return Err(format!("unknown operation: {op}")),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dual_shapes() {
        assert_eq!(dispatch("clampOffset", json!([120])).unwrap(), json!(60.0));
        assert_eq!(
            dispatch("clampOffset", json!({"offset":120})).unwrap(),
            json!(60.0)
        );
        assert_eq!(
            dispatch("clampOffset", json!([{"$number":"NaN"}])).unwrap(),
            json!(0.0)
        );
    }
    #[test]
    fn missing_median() {
        assert_eq!(
            dispatch("median", json!([[]])).unwrap(),
            json!({"$number":"NaN"})
        );
    }
}
