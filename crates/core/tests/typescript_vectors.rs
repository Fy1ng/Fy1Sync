//! Direct ports of the TypeScript unit-test scenarios, with the same 5x7 font.
use serde_json::{json, Value};
use stream_syncer_core::*;
const FONT: [(&str, [&str; 7]); 11] = [
    (
        "0",
        [
            "01110", "10001", "10011", "10101", "11001", "10001", "01110",
        ],
    ),
    (
        "1",
        [
            "00100", "01100", "00100", "00100", "00100", "00100", "01110",
        ],
    ),
    (
        "2",
        [
            "01110", "10001", "00001", "00010", "00100", "01000", "11111",
        ],
    ),
    (
        "3",
        [
            "11111", "00010", "00100", "00010", "00001", "10001", "01110",
        ],
    ),
    (
        "4",
        [
            "00010", "00110", "01010", "10010", "11111", "00010", "00010",
        ],
    ),
    (
        "5",
        [
            "11111", "10000", "11110", "00001", "00001", "10001", "01110",
        ],
    ),
    (
        "6",
        [
            "00110", "01000", "10000", "11110", "10001", "10001", "01110",
        ],
    ),
    (
        "7",
        [
            "11111", "00001", "00010", "00100", "01000", "01000", "01000",
        ],
    ),
    (
        "8",
        [
            "01110", "10001", "10001", "01110", "10001", "10001", "01110",
        ],
    ),
    (
        "9",
        [
            "01110", "10001", "10001", "01111", "00001", "00010", "01100",
        ],
    ),
    (
        ":",
        [
            "00000", "00100", "00100", "00000", "00100", "00100", "00000",
        ],
    ),
];

fn glyph(c: &str, scale: usize) -> Image {
    let rows = &FONT.iter().find(|(k, _)| *k == c).unwrap().1;
    let mut image = Image {
        data: vec![0; 5 * scale * 7 * scale],
        width: 5 * scale,
        height: 7 * scale,
    };
    for (y, row) in rows.iter().enumerate() {
        for (x, n) in row.bytes().enumerate() {
            if n == b'1' {
                for yy in y * scale..(y + 1) * scale {
                    for xx in x * scale..(x + 1) * scale {
                        image.data[yy * image.width + xx] = 255;
                    }
                }
            }
        }
    }
    image
}
fn profile(scale: usize, roi: RoiRect) -> RecognitionProfile {
    let mut p: RecognitionProfile =
        serde_json::from_value(empty_profile("cs2/test", "测试场景")).unwrap();
    p.roi = roi;
    p.preprocess = PreprocessSettings {
        scale: 1.6,
        threshold: 120.0,
        invert: false,
    };
    for c in CLOCK_CHARS {
        p.templates.insert(
            c.into(),
            vec![TemplateSample {
                id: format!("{c}-0"),
                data: pack_bitmap(&normalize_glyph(&glyph(c, scale))),
                created_at: 1.0,
                origin: None,
            }],
        );
    }
    p
}
fn clock(text: &str, scale: usize) -> (Vec<u8>, RoiRect) {
    let mut data = vec![0; 640 * 360 * 4];
    for p in data.chunks_mut(4) {
        p.copy_from_slice(&[12, 14, 18, 255]);
    }
    for (i, c) in text.chars().enumerate() {
        let g = glyph(&c.to_string(), scale);
        for y in 0..g.height {
            for x in 0..g.width {
                if g.data[y * g.width + x] != 0 {
                    let xx = 280 + i * 6 * scale + x;
                    let yy = 20 + y;
                    data[(yy * 640 + xx) * 4..(yy * 640 + xx) * 4 + 4]
                        .copy_from_slice(&[235, 238, 245, 255]);
                }
            }
        }
    }
    let width = text.len() * 6 * scale - scale;
    let roi = RoiRect {
        x: 274.0 / 640.0,
        y: 14.0 / 360.0,
        w: (width + 12) as f64 / 640.0,
        h: (7 * scale + 12) as f64 / 360.0,
    };
    (data, roi)
}
fn recognize(text: &str, render_scale: usize, template_scale: usize, threshold: f64) -> Value {
    let (frame, roi) = clock(text, render_scale);
    let mut p = profile(template_scale, roi);
    p.match_threshold = threshold;
    recognize_frame(
        &frame,
        640,
        360,
        &p,
        &compile_templates(&p),
        &json!({"mediaTime":12.5,"wallTime":1000,"frameIndex":7}),
        &json!({}),
    )
}
#[test]
fn canonical_glyph_dimensions() {
    let m = normalize_glyph(&glyph("7", 3));
    assert_eq!(m.len(), 1536);
    let b = bounding_box(&Image {
        data: m,
        width: 32,
        height: 48,
    })
    .unwrap();
    assert!(b.width <= 32.0 && b.height <= 48.0);
}
#[test]
fn scale_invariant() {
    assert!(
        score_masks(
            &normalize_glyph(&glyph("3", 2)),
            &normalize_glyph(&glyph("3", 11))
        ) > 0.8
    );
}
#[test]
fn narrow_glyph_stays_narrow() {
    assert!(
        score_masks(
            &normalize_glyph(&glyph("1", 6)),
            &normalize_glyph(&glyph("0", 6))
        ) < 0.6
    );
}
#[test]
fn one_pixel_wider_survives() {
    let g = glyph("0", 6);
    let mut padded = Image {
        data: vec![0; (g.width + 1) * g.height],
        width: g.width + 1,
        height: g.height,
    };
    for y in 0..g.height {
        padded.data[y * padded.width..y * padded.width + g.width]
            .copy_from_slice(&g.data[y * g.width..(y + 1) * g.width]);
    }
    padded.data[g.height / 2 * padded.width + g.width] = 255;
    assert!(score_coverage(&normalize_glyph_coverage(&padded), &normalize_glyph(&g)) > 0.82);
}
#[test]
fn every_character_matches() {
    let p = profile(
        6,
        RoiRect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        },
    );
    let t = compile_templates(&p);
    for c in CLOCK_CHARS {
        let m = match_glyph(&normalize_glyph(&glyph(c, 6)), &t);
        assert_eq!(m.char.as_deref(), Some(c));
        assert_eq!(m.score, 1.0);
        assert!(m.score - m.runner_up_score > 0.05);
    }
}
#[test]
fn reads_clock_end_to_end() {
    let r = recognize("1:37", 6, 6, 0.82);
    assert_eq!(r["outcome"]["status"], "success");
    assert_eq!(r["outcome"]["reading"]["text"], "1:37");
    assert_eq!(r["outcome"]["reading"]["seconds"], 97.0);
    assert_eq!(r["outcome"]["reading"]["mediaTime"], 12.5);
    assert_eq!(r["outcome"]["reading"]["frameIndex"], 7);
    assert_eq!(
        r["outcome"]["reading"]["scores"].as_array().unwrap().len(),
        4
    );
}
#[test]
fn different_render_size() {
    assert_eq!(recognize("0:45", 9, 4, 0.7)["outcome"]["status"], "success");
}
#[test]
fn threshold_changes_outcome() {
    assert_eq!(
        recognize("0:45", 9, 4, 0.99)["outcome"]["reason"],
        "low-confidence"
    );
}
#[test]
fn invalid_format_rejected() {
    assert_eq!(
        recognize("789", 6, 6, 0.82)["outcome"]["reason"],
        "invalid-format"
    );
}
#[test]
fn debug_masks_and_projection() {
    let r = recognize("2:15", 6, 6, 0.82);
    assert_eq!(r["debug"]["boxes"].as_array().unwrap().len(), 4);
    assert_eq!(r["debug"]["normalized"][0].as_array().unwrap().len(), 1536);
    let chars: Vec<_> = r["debug"]["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["char"].as_str().unwrap())
        .collect();
    assert_eq!(chars, ["2", ":", "1", "5"]);
}
#[test]
fn noisy_templates_rejected() {
    let (f, roi) = clock("1:37", 6);
    let p = profile(6, roi);
    let mut t = compile_templates(&p);
    for (c, m) in &mut t.masks {
        m[0] = (0..1536)
            .map(|i| {
                if (i * 7 + c.as_bytes()[0] as usize) % 5 == 0 {
                    255
                } else {
                    0
                }
            })
            .collect();
    }
    assert_eq!(
        recognize_frame(&f, 640, 360, &p, &t, &json!({}), &json!({}))["outcome"]["reason"],
        "low-confidence"
    );
}
#[test]
fn segmentation_order() {
    let (f, roi) = clock("1:37", 6);
    let p = profile(6, roi);
    let b = binarize(
        &crop_binary(
            &to_grayscale(&f, 640, 360),
            &roi_to_pixels(&p.roi, 640, 360),
        ),
        &p.preprocess,
    );
    let s = segment_glyphs(&b, &json!({}));
    assert_eq!(s.boxes.len(), 4);
    for bs in s.boxes.windows(2) {
        assert!(bs[1].x >= bs[0].x + bs[0].width);
    }
}
fn outcome(text: &str, frame: u32, confidence: f64) -> Value {
    json!({"status":"success","reading":{"text":text,"seconds":parse_countdown(text,"auto"),"scores":[1],"confidence":confidence,"mediaTime":frame as f64/30.0,"wallTime":frame as f64*(1000.0/30.0),"frameIndex":frame}})
}
fn feed(
    d: &mut ClockJumpDetector,
    text: &str,
    frame: u32,
    count: u32,
    confidence: f64,
) -> Vec<Value> {
    (frame..frame + count)
        .map(|i| d.push(outcome(text, i, confidence)))
        .collect()
}
#[test]
fn low_confidence_does_not_change_candidate() {
    let mut d = ClockJumpDetector::new("official", json!({"minConfidence":0.8}));
    feed(&mut d, "00:46", 0, 3, 0.95);
    assert!(feed(&mut d, "00:12", 30, 3, 0.4)
        .iter()
        .all(|v| v["dropped"] == "low-confidence"));
    assert!(feed(&mut d, "00:45", 60, 3, 0.95)[1]["event"].is_object());
}
#[test]
fn failed_frames_ignored() {
    let mut d = ClockJumpDetector::new("official", json!({}));
    feed(&mut d, "00:46", 0, 3, 0.95);
    d.push(json!({"status":"failed","reason":"blank-frame"}));
    assert!(feed(&mut d, "00:45", 30, 3, 0.95)[1]["event"].is_object());
}
#[test]
fn round_reset_rejected() {
    let mut d = ClockJumpDetector::new("official", json!({}));
    feed(&mut d, "00:01", 0, 3, 0.95);
    assert_eq!(
        feed(&mut d, "01:55", 30, 3, 0.95)[1]["dropped"],
        "not-decrement"
    );
}
#[test]
fn configured_stable_frames() {
    let mut d = ClockJumpDetector::new("official", json!({"stableFrames":4}));
    feed(&mut d, "00:46", 0, 5, 0.95);
    assert!(feed(&mut d, "00:45", 30, 3, 0.95)
        .iter()
        .all(|v| v["event"].is_null()));
    assert!(feed(&mut d, "00:45", 33, 1, 0.95)[0]["event"].is_object());
}
#[test]
fn unparsable_reading_rejected() {
    let mut d = ClockJumpDetector::new("official", json!({}));
    let mut o = outcome("00:45", 0, 0.95);
    o["reading"]["seconds"] = json!(44);
    assert_eq!(d.push(o)["dropped"], "unparsable");
}
fn jump(seconds: f64, wall: f64, confidence: f64) -> Value {
    json!({"toSeconds":seconds,"wallTime":wall*1000.0,"confidence":confidence})
}
#[test]
fn no_matching_text_needed() {
    assert_eq!(
        estimate_offset(
            &[jump(30.0, 20.0, 0.95)],
            &[jump(37.0, 20.0, 0.95)],
            &json!({})
        )["residualSeconds"],
        7.0
    );
}
#[test]
fn deadband_and_applied_offset() {
    let o = [jump(45.0, 10.0, 0.95)];
    assert_eq!(
        estimate_offset(&o, &[jump(45.0, 10.06, 0.95)], &json!({}))["direction"],
        "none"
    );
    assert_eq!(
        estimate_offset(
            &o,
            &[jump(45.0, 12.0, 0.95)],
            &json!({"appliedOffsetSeconds":3})
        )["totalOffsetSeconds"],
        5.0
    );
}
#[test]
fn residual_flips_direction() {
    assert_eq!(
        estimate_offset(
            &[jump(45.0, 12.0, 0.95)],
            &[jump(45.0, 10.0, 0.95)],
            &json!({"appliedOffsetSeconds":1})
        )["totalOffsetSeconds"],
        -1.0
    );
}
#[test]
fn rejects_unstable_and_low_confidence() {
    let c = [jump(45.0, 10.0, 0.95)];
    assert_eq!(
        estimate_offset(
            &[jump(45.0, 10.0, 0.95), jump(44.0, 12.5, 0.95)],
            &c,
            &json!({})
        )["reason"],
        "unstable-official"
    );
    assert_eq!(
        estimate_offset(
            &c,
            &[jump(45.0, 10.0, 0.95), jump(44.0, 12.5, 0.95)],
            &json!({})
        )["reason"],
        "unstable-commentary"
    );
    assert_eq!(
        estimate_offset(&[jump(45.0, 10.0, 0.6)], &c, &json!({}))["reason"],
        "low-confidence"
    );
    assert_eq!(
        estimate_offset(&c, &[], &json!({}))["reason"],
        "no-commentary-jump"
    );
}
#[test]
fn rejects_out_of_range() {
    assert_eq!(
        estimate_offset(
            &[jump(10.0, 10.0, 0.95)],
            &[jump(45.0, 100.0, 0.95)],
            &json!({})
        )["reason"],
        "out-of-range"
    );
}
#[test]
fn median_anchor_estimate() {
    let o = [
        jump(45.0, 10.0, 0.95),
        jump(44.0, 11.0, 0.95),
        jump(43.0, 12.0, 0.95),
    ];
    let c = [
        jump(45.0, 12.0, 0.95),
        jump(44.0, 13.05, 0.95),
        jump(43.0, 14.0, 0.95),
    ];
    let r = estimate_offset(&o, &c, &json!({}));
    assert_eq!(r["residualSeconds"], 2.0);
    assert!(r["commentaryAnchorSpread"].as_f64().unwrap() > 0.0);
}
fn vod(time: f64) -> Value {
    json!({"ready":true,"currentTime":time,"timebase":{"kind":"vod","duration":600}})
}
fn plan(next: f64, o: f64, c: f64, ot: f64, ct: f64) -> Value {
    plan_offset_change(
        &json!({"nextOffset":next,"applied":{"official":o,"commentary":c},"snapshots":{"official":vod(ot),"commentary":vod(ct)}}),
    )
}
#[test]
fn positive_negative_plan() {
    let p = plan(5.0, 0.0, 0.0, 100.0, 100.0);
    assert_eq!(p["seeks"][0]["role"], "official");
    assert_eq!(p["seeks"][0]["to"], 95.0);
    assert!(plan_is_complete(&p, 0.05));
    let p = plan(-4.0, 0.0, 0.0, 50.0, 50.0);
    assert_eq!(p["seeks"][0]["role"], "commentary");
    assert_eq!(p["seeks"][0]["to"], 46.0);
}
#[test]
fn zero_and_sign_flip_restore() {
    let p = plan(0.0, 3.0, 0.0, 97.0, 100.0);
    assert_eq!(p["seeks"][0]["to"], 100.0);
    let p = plan(-2.0, 3.0, 0.0, 97.0, 100.0);
    assert_eq!(p["seeks"][0]["to"], 100.0);
    assert_eq!(p["seeks"][1]["to"], 98.0);
    assert_eq!(p["effectiveOffset"], -2.0);
}
#[test]
fn repeat_does_not_accumulate() {
    assert_eq!(plan(5.0, 5.0, 0.0, 95.0, 100.0)["seeks"], json!([]));
}
#[test]
fn missing_source_and_maximum() {
    let p = plan_offset_change(
        &json!({"nextOffset":4,"applied":{"official":0,"commentary":0},"snapshots":{"commentary":vod(30.0)}}),
    );
    assert_eq!(p["missingRoles"], json!(["official"]));
    assert_eq!(p["limitReason"], "not-ready");
    assert_eq!(plan(90.0, 0.0, 0.0, 300.0, 300.0)["requestedOffset"], 60.0);
}
#[test]
fn range_rewind_and_alignment() {
    assert_eq!(available_rewind(&vod(4.0)), 4.0);
    assert_eq!(
        available_rewind(
            &json!({"currentTime":1000,"timebase":{"kind":"live","seekableStart":940,"seekableEnd":1002}})
        ),
        60.0
    );
    assert!(is_aligned(-0.08, 0.1));
    assert!(!is_aligned(0.2, 0.1));
    assert_eq!(describe_offset(-1.18, 0.1), "让国内解说后退 1.18 秒");
}

#[test]
fn engine_preserves_numeric_metadata() {
    let (frame, roi) = clock("1:37", 6);
    let p = profile(6, roi);
    let mut engine = Engine::new();
    engine
        .configure(&serde_json::to_string(&p).unwrap())
        .unwrap();
    for index in [4_294_967_313.0, -1.0, 1.5] {
        let result = engine.recognize(&frame, 640, 360, -0.0, -0.0, index, false);
        let reading = &result["outcome"]["reading"];
        assert_eq!(reading["frameIndex"].as_f64().unwrap(), index);
        assert!(reading["mediaTime"].as_f64().unwrap().is_sign_negative());
        assert!(reading["wallTime"].as_f64().unwrap().is_sign_negative());
    }
}
