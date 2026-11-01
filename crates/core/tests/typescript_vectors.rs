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
fn hud_pack(profile: &RecognitionProfile, width:usize, height:usize) -> Value {
    let mut bitmaps=serde_json::Map::new();
    let mut glyphs=serde_json::Map::new();
    for (c,samples) in &profile.templates {
        let mut ids=vec![];
        for (i,sample) in samples.iter().enumerate() {
            let id=format!("glyph-{}-{i}",if c==":" {"colon"}else{c});
            bitmaps.insert(id.clone(),json!({"width":32,"height":48,"data":sample.data}));
            ids.push(id);
        }
        glyphs.insert(c.clone(),json!(ids));
    }
    let rect=roi_to_pixels(&profile.roi,width,height);
    json!({"kind":"hud-style-pack","schemaVersion":1,"id":profile.id,"revision":1,"name":profile.name,"bitmaps":bitmaps,"variants":[{
        "id":"official-top-360","nativeSize":{"width":width,"height":height},
        "fields":{"clock":{"enabled":true,"roi":{"x":rect.x as usize,"y":rect.y as usize,"w":rect.width as usize,"h":rect.height as usize},
            "preprocess":HudPreprocessSettings::from_internal(&profile.preprocess),"segment":{"minColumnInk":1,"minGlyphWidth":2,"minGapWidth":1,"minInkRatio":0.08},
            "glyphs":glyphs,"grammar":{"kind":"countdown","format":profile.clock_format},"match":{"minScore":profile.match_threshold,"minMargin":0.02},"gateCue":null},
            "scoreLeft":null,"scoreRight":null},"cues":{},"states":{},"organizer":null}]})
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
        .configure(&hud_pack(&p,640,360).to_string())
        .unwrap();
    for index in [4_294_967_313.0, -1.0, 1.5] {
        let result = engine.recognize(&frame, 640, 360, -0.0, -0.0, index, false);
        let reading = &result["outcome"]["reading"];
        assert_eq!(reading["frameIndex"].as_f64().unwrap(), index);
        assert!(reading["mediaTime"].as_f64().unwrap().is_sign_negative());
        assert!(reading["wallTime"].as_f64().unwrap().is_sign_negative());
    }
}

#[test]
fn full_frame_hud_and_glyph_preparation_share_every_intermediate() {
    let (frame,roi)=clock("1:37",6);
    let pack=parse_hud_style_pack(&hud_pack(&profile(6,roi),640,360)).unwrap();
    let result=recognize_hud_frame(&frame,640,360,&pack,"official-top-360").unwrap();
    assert!(matches!(result.fields.score_left,HudFieldResult::Failed{ref reason,..} if reason=="not-configured"));
    assert!(matches!(result.fields.score_right,HudFieldResult::Failed{ref reason,..} if reason=="not-configured"));
    assert!(matches!(result.fields.round,HudFieldResult::Failed{ref reason,..} if reason=="score-failed"));
    assert!(result.cues.is_empty());
    assert!(result.states.is_empty());
    assert!(matches!(result.organizer,HudPresenceResult::Failed{ref reason,..} if reason=="not-configured"));
    let HudFieldResult::Read{reading,debug:Some(debug)}=result.fields.clock else {panic!("{result:?}")};
    assert_eq!(reading.text,"1:37");
    assert_eq!(reading.value,97.0);
    let prepared=prepare_hud_glyphs(&frame,640,360,&pack,"official-top-360","clock").unwrap();
    assert_eq!(prepared.roi_pixels,debug.roi_pixels);
    assert_eq!(prepared.gray,debug.gray);
    assert_eq!(prepared.binary,debug.binary);
    assert_eq!(prepared.boxes,debug.boxes);
    assert_eq!(prepared.projection,debug.projection);
    assert_eq!(prepared.normalized,debug.normalized);
    for (bitmap,mask) in prepared.bitmaps.iter().zip(&prepared.normalized) {assert_eq!(&unpack_bitmap(bitmap,1536).unwrap(),mask);}
    let custom=prepare_hud_glyphs_with_boxes(&frame,640,360,&pack,"official-top-360","clock",Some(prepared.boxes.clone())).unwrap();
    assert_eq!(custom.bitmaps,prepared.bitmaps);
    let mut bad=prepared.boxes; bad[0].x=-1.0;
    assert!(prepare_hud_glyphs_with_boxes(&frame,640,360,&pack,"official-top-360","clock",Some(bad)).is_err());
    assert!(recognize_hud_frame(&frame,640,360,&pack,"missing").is_err());
    assert!(recognize_hud_frame(&frame,640,359,&pack,"official-top-360").is_err());
    assert!(recognize_hud_frame(&frame[..frame.len()-1],640,360,&pack,"official-top-360").is_err());
}

#[test]
fn hud_countdown_confidence_excludes_colon_without_hiding_its_score_or_relaxing_its_gates() {
    let (frame, roi) = clock("1:37", 6);
    let mut pack = parse_hud_style_pack(&hud_pack(&profile(6, roi), 640, 360)).unwrap();
    let colon_id = pack.variants[0].fields.clock.as_ref().unwrap().glyphs[":"].first().unwrap().clone();
    let bitmap = pack.bitmaps.get_mut(&colon_id).unwrap();
    let mut mask = unpack_bitmap(&bitmap.data, 1536).unwrap();
    let mut ink = 0;
    for pixel in &mut mask {
        if *pixel != 0 {
            ink += 1;
            if ink % 7 == 0 { *pixel = 0; }
        }
    }
    bitmap.data = pack_bitmap(&mask);
    pack.variants[0].fields.clock.as_mut().unwrap().r#match.min_score = 0.7;
    let original = serde_json::to_value(&pack).unwrap();
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    let HudFieldResult::Read { reading, debug: Some(debug) } = result.fields.clock else { panic!("{result:?}") };
    let colon = &debug.matches[1];
    assert_eq!(reading.text, "1:37");
    assert_eq!(reading.scores.len(), 4);
    assert_eq!(colon.char.as_deref(), Some(":"));
    assert!(colon.score > 0.7 && colon.score < 0.9);
    assert!(colon.score - colon.runner_up_score > 0.2);
    assert_eq!(reading.scores[1], colon.score);
    let digits = debug.matches.iter().filter(|m| m.char.as_deref() != Some(":"))
        .map(|m| m.score).fold(1.0, f64::min);
    assert_eq!(reading.confidence, digits);
    assert!(reading.confidence > colon.score);
    assert_eq!(serde_json::to_value(&pack).unwrap(), original);

    pack.variants[0].fields.clock.as_mut().unwrap().r#match.min_score = (colon.score + digits) / 2.0;
    let gated = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert!(matches!(gated.fields.clock, HudFieldResult::Failed { ref reason, .. } if reason == "low-confidence"));
}

#[test]
fn hud_small_video_cannot_expand_an_unbounded_reference_region() {
    let (_, roi) = clock("1:37", 6);
    let mut pack = parse_hud_style_pack(&hud_pack(&profile(6, roi), 640, 360)).unwrap();
    pack.variants[0].native_size = HudSize { width: 8192, height: 8192 };
    pack.variants[0].fields.clock.as_mut().unwrap().roi = HudRoi { x: 0, y: 0, w: 8192, h: 8192 };
    let tiny = [0, 0, 0, 255];
    assert!(recognize_hud_frame(&tiny, 1, 1, &pack, "").unwrap_err().contains("安全上限"));
    assert!(prepare_hud_glyphs(&tiny, 1, 1, &pack, "official-top-360", "clock").unwrap_err().contains("安全上限"));
}

#[test]
fn hud_ambiguous_colon_and_invalid_colon_placement_are_still_rejected() {
    let (frame, roi) = clock("1:37", 6);
    let mut pack = parse_hud_style_pack(&hud_pack(&profile(6, roi), 640, 360)).unwrap();
    let colon_id = pack.variants[0].fields.clock.as_ref().unwrap().glyphs[":"].first().unwrap().clone();
    let mut near_colon = unpack_bitmap(&pack.bitmaps[&colon_id].data, 1536).unwrap();
    *near_colon.iter_mut().find(|pixel| **pixel == 0).unwrap() = 255;
    pack.bitmaps.insert("ambiguous-two".into(), HudBitmap { width: 32, height: 48, data: pack_bitmap(&near_colon) });
    pack.variants[0].fields.clock.as_mut().unwrap().glyphs.get_mut("2").unwrap().push("ambiguous-two".into());
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    let HudFieldResult::Failed { reason, debug: Some(debug) } = result.fields.clock else { panic!("{result:?}") };
    assert_eq!(reason, "low-confidence");
    assert!(debug.matches[1].score - debug.matches[1].runner_up_score < 0.02);

    let (bad_frame, bad_roi) = clock("13:7", 6);
    let mut bad_pack = parse_hud_style_pack(&hud_pack(&profile(6, bad_roi), 640, 360)).unwrap();
    bad_pack.variants[0].fields.clock.as_mut().unwrap().grammar = HudGrammar::Countdown { format: "m:ss".into() };
    let result = recognize_hud_frame(&bad_frame, 640, 360, &bad_pack, "").unwrap();
    assert!(matches!(result.fields.clock, HudFieldResult::Failed { ref reason, .. } if reason == "invalid-format"));
}

#[test]
fn hud_seconds_only_and_integer_readings_keep_the_lowest_digit_confidence() {
    let (frame, roi) = clock("37", 6);
    let mut pack = parse_hud_style_pack(&hud_pack(&profile(6, roi), 640, 360)).unwrap();
    pack.variants[0].fields.clock.as_mut().unwrap().grammar = HudGrammar::Countdown { format: "ss".into() };
    pack.variants[0].fields.clock.as_mut().unwrap().glyphs.remove(":");
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    let HudFieldResult::Read { reading, .. } = result.fields.clock else { panic!("{result:?}") };
    assert_eq!(reading.text, "37");
    assert_eq!(reading.confidence, reading.scores.iter().copied().fold(1.0, f64::min));

    let (frame, pack) = scoreboard("18", "7");
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    for field in [result.fields.score_left, result.fields.score_right] {
        let HudFieldResult::Read { reading, .. } = field else { panic!("{field:?}") };
        assert_eq!(reading.confidence, reading.scores.iter().copied().fold(1.0, f64::min));
    }
}

fn nearest_rgba(frame: &[u8], width: usize, height: usize, target_width: usize, target_height: usize) -> Vec<u8> {
    let mut output = vec![0; target_width * target_height * 4];
    for y in 0..target_height {
        for x in 0..target_width {
            let source = ((y * height / target_height) * width + x * width / target_width) * 4;
            output[(y * target_width + x) * 4..(y * target_width + x) * 4 + 4].copy_from_slice(&frame[source..source + 4]);
        }
    }
    output
}

#[test]
fn hud_reference_layout_reads_smaller_larger_and_differently_shaped_frames_without_mutation() {
    let (frame, roi) = clock("1:37", 6);
    let pack = parse_hud_style_pack(&hud_pack(&profile(6, roi), 640, 360)).unwrap();
    let before = serde_json::to_value(&pack).unwrap();
    let native = prepare_hud_glyphs(&frame, 640, 360, &pack, "official-top-360", "clock").unwrap();
    for (width, height) in [(320, 180), (960, 540), (1280, 720), (1920, 1080), (1280, 360)] {
        let resized = nearest_rgba(&frame, 640, 360, width, height);
        for id in ["", "official-top-360"] {
            let result = recognize_hud_frame(&resized, width, height, &pack, id).unwrap();
            let HudFieldResult::Read { reading, debug: Some(debug) } = result.fields.clock else { panic!("{width}x{height}: {result:?}") };
            assert_eq!(result.variant_id.as_deref(), Some("official-top-360"));
            assert_eq!(reading.text, "1:37");
            assert_eq!(debug.binary, native.binary);
            assert_eq!(debug.boxes, native.boxes);
            let prepared = prepare_hud_glyphs(&resized, width, height, &pack, "official-top-360", "clock").unwrap();
            assert_eq!(prepared.binary, debug.binary);
            assert_eq!(prepared.roi_pixels, debug.roi_pixels);
            assert_eq!(prepared.bitmaps, native.bitmaps);
            let custom = prepare_hud_glyphs_with_boxes(&resized, width, height, &pack, "official-top-360", "clock", Some(native.boxes.clone())).unwrap();
            assert_eq!(custom.bitmaps, native.bitmaps);
            assert_eq!(debug.roi_pixels.x, js_round(native.roi_pixels.x * width as f64 / 640.0));
            assert_eq!(debug.roi_pixels.y, js_round(native.roi_pixels.y * height as f64 / 360.0));
            assert_eq!(debug.roi_pixels.width, js_round(native.roi_pixels.width * width as f64 / 640.0));
            assert_eq!(debug.roi_pixels.height, js_round(native.roi_pixels.height * height as f64 / 360.0));
        }
    }
    assert_eq!(serde_json::to_value(&pack).unwrap(), before);
}

#[test]
fn hud_reference_cues_scores_states_and_organizer_share_mapped_pixels() {
    let (mut frame, mut pack) = scoreboard("18", "7");
    let mask = [255, 0, 255, 0, 255, 0, 255, 0, 255];
    pack.bitmaps.insert("mark".into(), HudBitmap { width: 3, height: 3, data: pack_bitmap(&mask) });
    let cue = HudCue { enabled: true, roi: HudRoi { x: 7, y: 11, w: 3, h: 3 },
        preprocess: HudPreprocessSettings { scale: 1.0, ..HudPreprocessSettings::default() }, templates: vec!["mark".into()], min_score: 1.0 };
    pack.variants[0].cues.insert("timeoutRight".into(), cue.clone());
    pack.variants[0].organizer = Some(cue);
    paint_layout_mark(&mut frame, 7);
    let native = prepare_hud_cue(&frame, 640, 360, &pack, "official-top-360", "timeoutRight").unwrap();
    for (width, height) in [(1280, 720), (1920, 1080)] {
        let resized = nearest_rgba(&frame, 640, 360, width, height);
        let result = recognize_hud_frame(&resized, width, height, &pack, "").unwrap();
        assert_eq!(result.phase, "paused");
        assert!(matches!(result.cues["timeoutRight"], HudPresenceResult::Matched { score: Some(1.0), .. }));
        assert!(matches!(result.organizer, HudPresenceResult::Matched { score: Some(1.0), .. }));
        for (field, expected) in [(&result.fields.score_left, "18"), (&result.fields.score_right, "7")] {
            assert!(matches!(field, HudFieldResult::Read { reading, .. } if reading.text == expected));
        }
        assert!(matches!(result.fields.round, HudFieldResult::Read { reading, .. } if reading.value == 26.0));
        let prepared = prepare_hud_cue(&resized, width, height, &pack, "official-top-360", "timeoutRight").unwrap();
        assert_eq!(prepared.bitmap, native.bitmap);
        assert_eq!(prepared.gray, native.gray);
        assert_eq!(prepared.binary, native.binary);
        assert_eq!(prepared.roi_pixels, Rect { x: 7.0 * width as f64 / 640.0, y: 11.0 * height as f64 / 360.0,
            width: 3.0 * width as f64 / 640.0, height: 3.0 * height as f64 / 360.0 });
    }
}

#[test]
fn hud_cross_resolution_layout_selection_keeps_conflicts_and_prefers_exact_candidates() {
    let (mut frame, mut pack) = layout_pack();
    paint_layout_mark(&mut frame, 7);
    let resized = nearest_rgba(&frame, 640, 360, 1280, 720);
    let result = recognize_hud_frame(&resized, 1280, 720, &pack, "").unwrap();
    assert_eq!(result.variant_id.as_deref(), Some("official-top-360"));
    paint_layout_mark(&mut frame, 21);
    let both = nearest_rgba(&frame, 640, 360, 1280, 720);
    assert_indeterminate_layout(&recognize_hud_frame(&both, 1280, 720, &pack, "").unwrap(), "multiple-matches");
    let explicit = recognize_hud_frame(&both, 1280, 720, &pack, "official-bottom-360").unwrap();
    assert_eq!(explicit.variant_id.as_deref(), Some("official-bottom-360"));
    let mut exact = pack.variants[0].clone();
    exact.id = "native-720".into();
    exact.native_size = HudSize { width: 1280, height: 720 };
    exact.organizer = None;
    pack.variants.push(exact);
    assert_eq!(recognize_hud_frame(&both, 1280, 720, &pack, "").unwrap().variant_id.as_deref(), Some("native-720"));
}

#[test]
fn hud_scaled_hsv_pick_uses_original_rgb_and_recommendations_do_not_modify_the_pack() {
    let (frame, mut pack) = scoreboard("8", "9");
    let cue = HudCue { enabled: true, roi: HudRoi { x: 100, y: 80, w: 6, h: 6 },
        preprocess: HudPreprocessSettings::default(), templates: vec![], min_score: 0.9 };
    pack.variants[0].organizer = Some(cue);
    let mut resized = nearest_rgba(&frame, 640, 360, 1280, 720);
    let (x, y) = (201, 161);
    resized[(y * 1280 + x) * 4..(y * 1280 + x) * 4 + 4].copy_from_slice(&[60, 0, 0, 255]);
    let before = serde_json::to_value(&pack).unwrap();
    let picked = recommend_hud_preprocess(&resized, 1280, 720, &pack, "official-top-360", "organizer", &HudPreprocessRequest::Hsv { x, y }).unwrap();
    let settings = picked.settings.unwrap();
    assert_eq!(settings.hsv.hue, 0.0);
    assert_eq!(settings.hsv.saturation_min, 0.8);
    assert_eq!(settings.hsv.value_max, 60.0 / 255.0 + 0.25);
    for (x, y) in [(199, 160), (212, 160), (200, 159), (200, 172)] {
        assert!(recommend_hud_preprocess(&resized, 1280, 720, &pack, "official-top-360", "organizer", &HudPreprocessRequest::Hsv { x, y }).is_err());
    }
    for request in [HudPreprocessRequest::Threshold {}, HudPreprocessRequest::Polarity {}] {
        let native = recommend_hud_preprocess(&frame, 640, 360, &pack, "official-top-360", "scoreLeft", &request).unwrap();
        let scaled = recommend_hud_preprocess(&resized, 1280, 720, &pack, "official-top-360", "scoreLeft", &request).unwrap();
        assert_eq!(serde_json::to_value(native).unwrap(), serde_json::to_value(scaled).unwrap());
    }
    assert_eq!(serde_json::to_value(&pack).unwrap(), before);
}

#[test]
fn hud_scaled_edge_regions_remain_inside_frame_and_empty_or_overflowing_frames_are_rejected() {
    let (_, mut pack) = scoreboard("8", "9");
    pack.variants[0].fields.score_left.as_mut().unwrap().roi = HudRoi { x: 639, y: 359, w: 1, h: 1 };
    pack.variants[0].organizer = Some(HudCue { enabled: true, roi: HudRoi { x: 639, y: 359, w: 1, h: 1 },
        preprocess: HudPreprocessSettings::default(), templates: vec![], min_score: 0.9 });
    for (width, height) in [(1, 1), (3, 2), (319, 179), (1279, 719)] {
        let data = vec![160; width * height * 4];
        let glyphs = prepare_hud_glyphs(&data, width, height, &pack, "official-top-360", "scoreLeft").unwrap();
        let cue = prepare_hud_cue(&data, width, height, &pack, "official-top-360", "organizer").unwrap();
        for rect in [glyphs.roi_pixels, cue.roi_pixels] {
            assert!(rect.x >= 0.0 && rect.y >= 0.0 && rect.width >= 1.0 && rect.height >= 1.0);
            assert!(rect.x + rect.width <= width as f64 && rect.y + rect.height <= height as f64);
        }
        assert_eq!(cue.binary.width, 1);
        assert_eq!(cue.binary.height, 1);
    }
    for (width, height) in [(0, 0), (0, 1), (1, 0), (usize::MAX, 2)] {
        assert!(recognize_hud_frame(&[], width, height, &pack, "").is_err());
        assert!(prepare_hud_glyphs(&[], width, height, &pack, "official-top-360", "clock").is_err());
        assert!(prepare_hud_cue(&[], width, height, &pack, "official-top-360", "organizer").is_err());
        assert!(recommend_hud_preprocess(&[], width, height, &pack, "official-top-360", "clock", &HudPreprocessRequest::Polarity {}).is_err());
    }
}

#[test]
fn hud_configure_rejects_old_and_unknown_data_before_replacing_a_pack() {
    let (frame,roi)=clock("1:37",6);
    let profile=profile(6,roi);
    let mut engine=Engine::new();
    engine.configure(&hud_pack(&profile,640,360).to_string()).unwrap();
    let mut bad=hud_pack(&profile,640,360);bad["variants"][0]["fields"]["clock"]["preprocess"]["channel"]=json!("red");
    let error=engine.configure(&bad.to_string()).unwrap_err();
    assert!(error.contains("variants[0].fields.clock.preprocess.channel"));
    assert_eq!(engine.recognize(&frame,640,360,0.0,0.0,0.0,true)["outcome"]["reason"],"no-profile");
    assert!(engine.configure("{\"schemaVersion\":2}").unwrap_err().contains("重新制作"));
    assert!(engine.configure(&serde_json::to_string(&profile).unwrap()).is_err());
}

#[test]
fn hud_honors_segment_and_matching_settings() {
    let (frame,roi)=clock("1:37",6);
    let mut pack=parse_hud_style_pack(&hud_pack(&profile(6,roi),640,360)).unwrap();
    pack.variants[0].fields.clock.as_mut().unwrap().r#match.min_margin=1.0;
    let result=recognize_hud_frame(&frame,640,360,&pack,"official-top-360").unwrap();
    assert!(matches!(result.fields.clock,HudFieldResult::Failed{ref reason,..} if reason=="low-confidence"));
    let field=pack.variants[0].fields.clock.as_mut().unwrap();
    field.r#match.min_margin=0.02;field.segment.min_glyph_width=1000;
    let result=recognize_hud_frame(&frame,640,360,&pack,"official-top-360").unwrap();
    assert!(matches!(result.fields.clock,HudFieldResult::Failed{ref reason,..} if reason=="no-candidates"));
}

#[test]
fn hud_cues_organizer_and_preparation_share_the_whole_region() {
    let (mut frame,roi)=clock("1:37",6);
    let mut value=hud_pack(&profile(6,roi),640,360);
    let mask=[255,0,255,0,255,0,255,0,255];
    value["bitmaps"]["mark"]=json!({"width":3,"height":3,"data":pack_bitmap(&mask)});
    value["bitmaps"]["other-mark"]=json!({"width":3,"height":3,"data":pack_bitmap(&[0,255,0,255,0,255,0,255,0])});
    let cue=json!({"enabled":true,"roi":{"x":7,"y":11,"w":3,"h":3},"preprocess":HudPreprocessSettings::default(),"templates":["other-mark","mark"],"minScore":1.0});
    value["variants"][0]["cues"]["replay"]=cue.clone();
    value["variants"][0]["states"]["replay"]=json!([[{"kind":"cue","cue":"replay","present":true}]]);
    value["variants"][0]["organizer"]=cue;
    let pack=parse_hud_style_pack(&value).unwrap();
    let result=recognize_hud_frame(&frame,640,360,&pack,"official-top-360").unwrap();
    assert!(matches!(result.cues["replay"],HudPresenceResult::NotMatched{score:Some(0.0),..}));
    assert!(matches!(result.states["replay"],HudPresenceResult::NotMatched{score:None,debug:None}));
    assert!(matches!(result.organizer,HudPresenceResult::NotMatched{score:Some(0.0),..}));
    assert_eq!(result.content,"live");
    for (i, pixel) in mask.iter().enumerate() {
        let offset=((11+i/3)*640+7+i%3)*4;
        frame[offset..offset+3].fill(*pixel);
    }
    let result=recognize_hud_frame(&frame,640,360,&pack,"official-top-360").unwrap();
    let HudPresenceResult::Matched{score:Some(score),debug:Some(debug)}=&result.cues["replay"] else { panic!("{result:?}") };
    assert_eq!(*score,1.0);
    assert_eq!(debug.roi_pixels,Rect{x:7.0,y:11.0,width:3.0,height:3.0});
    assert_eq!(debug.binary.data,mask);
    assert_eq!(result.content,"replay");
    assert!(matches!(result.organizer,HudPresenceResult::Matched{score:Some(1.0),..}));
    for cue_id in ["replay","organizer"] {
        let prepared=prepare_hud_cue(&frame,640,360,&pack,"official-top-360",cue_id).unwrap();
        assert_eq!(prepared.gray,debug.gray);
        assert_eq!(prepared.binary,debug.binary);
        assert_eq!(unpack_bitmap(&prepared.bitmap,9).unwrap(),mask);
    }
    assert!(prepare_hud_cue(&frame,640,360,&pack,"official-top-360","bomb").is_err());
    assert!(prepare_hud_cue(&frame,640,359,&pack,"official-top-360","replay").is_err());
    value["variants"][0]["cues"]["replay"]["templates"]=json!([]);
    value["variants"][0]["organizer"]["templates"]=json!([]);
    let empty=parse_hud_style_pack(&value).unwrap();
    let result=recognize_hud_frame(&frame,640,360,&empty,"official-top-360").unwrap();
    assert!(matches!(result.cues["replay"],HudPresenceResult::Failed{ref reason,score:None,debug:Some(_)} if reason=="insufficient-templates"));
    assert!(matches!(result.organizer,HudPresenceResult::Failed{ref reason,..} if reason=="insufficient-templates"));
    assert!(matches!(result.states["replay"],HudPresenceResult::Failed{ref reason,..} if reason=="dependency-failed"));
    assert_eq!(result.content,"indeterminate");
}

fn layout_pack() -> (Vec<u8>, HudStylePack) {
    let (frame, roi) = clock("1:37", 6);
    let mut value = hud_pack(&profile(6, roi), 640, 360);
    let mask = [255, 0, 255, 0, 255, 0, 255, 0, 255];
    value["bitmaps"]["organizer"] = json!({"width":3,"height":3,"data":pack_bitmap(&mask)});
    value["variants"][0]["organizer"] = json!({
        "enabled":true,
        "roi":{"x":7,"y":11,"w":3,"h":3},
        "preprocess":HudPreprocessSettings { scale: 1.0, ..HudPreprocessSettings::default() },
        "templates":["organizer"],"minScore":1.0
    });
    let mut bottom = value["variants"][0].clone();
    bottom["id"] = json!("official-bottom-360");
    bottom["organizer"]["roi"]["x"] = json!(21);
    value["variants"].as_array_mut().unwrap().push(bottom);
    (frame, parse_hud_style_pack(&value).unwrap())
}

fn paint_layout_mark(frame: &mut [u8], x: usize) {
    for (i, pixel) in [255, 0, 255, 0, 255, 0, 255, 0, 255].iter().enumerate() {
        let offset = ((11 + i / 3) * 640 + x + i % 3) * 4;
        frame[offset..offset + 3].fill(*pixel);
    }
}

fn assert_indeterminate_layout(result: &HudFrameResult, reason: &str) {
    assert_eq!(result.variant_id, None);
    assert_eq!(result.selection_reason.as_deref(), Some(reason));
    assert_eq!(result.content, "indeterminate");
    assert_eq!(result.phase, "indeterminate");
    for field in [&result.fields.clock, &result.fields.score_left, &result.fields.score_right, &result.fields.round] {
        assert!(matches!(field, HudFieldResult::Indeterminate { reason: value, debug: None } if value == reason));
    }
}

#[test]
fn hud_auto_layout_selects_each_same_size_variant_by_its_organizer() {
    let (frame, pack) = layout_pack();
    for (x, id) in [(7, "official-top-360"), (21, "official-bottom-360")] {
        let mut marked = frame.clone();
        paint_layout_mark(&mut marked, x);
        let result = recognize_hud_frame(&marked, 640, 360, &pack, "").unwrap();
        assert_eq!(result.variant_id.as_deref(), Some(id));
        assert_eq!(result.selection_reason, None);
        assert!(matches!(result.organizer, HudPresenceResult::Matched { score: Some(1.0), .. }));
        assert!(matches!(result.fields.clock, HudFieldResult::Read { reading, .. } if reading.value == 97.0));
    }
}

#[test]
fn hud_auto_layout_no_matches_is_indeterminate_and_has_no_readings() {
    let (frame, pack) = layout_pack();
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_indeterminate_layout(&result, "no-match");
    let no_size = recognize_hud_frame(&[0; 16], 2, 2, &pack, "").unwrap();
    assert_indeterminate_layout(&no_size, "no-match");
    assert!(recognize_hud_frame(&frame[..frame.len() - 1], 640, 360, &pack, "").is_err());
}

#[test]
fn hud_auto_layout_multiple_matches_is_indeterminate_and_explicit_inspection_still_works() {
    let (mut frame, pack) = layout_pack();
    paint_layout_mark(&mut frame, 7);
    paint_layout_mark(&mut frame, 21);
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_indeterminate_layout(&result, "multiple-matches");
    let explicit = recognize_hud_frame(&frame, 640, 360, &pack, "official-bottom-360").unwrap();
    assert_eq!(explicit.variant_id.as_deref(), Some("official-bottom-360"));
    assert_eq!(explicit.selection_reason, None);
}

#[test]
fn hud_auto_layout_single_same_size_variant_does_not_require_organizer_match() {
    let (frame, mut pack) = layout_pack();
    // A different resolution does not turn a single native layout into a multi-layout choice.
    pack.variants[1].native_size.height = 720;
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_eq!(result.variant_id.as_deref(), Some("official-top-360"));
    assert!(matches!(result.organizer, HudPresenceResult::NotMatched { .. }));
    assert!(matches!(result.fields.clock, HudFieldResult::Read { .. }));
    pack.variants[0].organizer = None;
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_eq!(result.variant_id.as_deref(), Some("official-top-360"));
    assert_eq!(result.content, "live");
    assert_eq!(result.phase, "unconfigured");
    assert!(matches!(result.fields.clock, HudFieldResult::Read { .. }));
}

#[test]
fn hud_auto_layout_never_selects_a_variant_without_organizer_among_multiple_layouts() {
    let (mut frame, mut pack) = layout_pack();
    paint_layout_mark(&mut frame, 7);
    pack.variants[0].organizer = None;
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_indeterminate_layout(&result, "no-match");
    paint_layout_mark(&mut frame, 21);
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_eq!(result.variant_id.as_deref(), Some("official-bottom-360"));
    pack.variants[1].organizer.as_mut().unwrap().templates.clear();
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_indeterminate_layout(&result, "no-match");
}

#[test]
fn bomb_and_statistics_provide_positive_evidence_of_missing_fields() {
    let (frame,roi)=clock("1:37",6);
    let mut value=hud_pack(&profile(6,roi),640,360);
    value["bitmaps"]["mark"]=json!({"width":3,"height":3,"data":pack_bitmap(&[255,0,255,0,255,0,255,0,255])});
    let cue=json!({"enabled":true,"roi":{"x":0,"y":0,"w":3,"h":3},"preprocess":HudPreprocessSettings { scale: 1.0, ..HudPreprocessSettings::default() },"templates":["mark"],"minScore":0.8});
    value["variants"][0]["cues"]["bomb"]=cue.clone();
    value["variants"][0]["states"]["planted"]=json!([[{"kind":"cue","cue":"bomb","present":true},{"kind":"field","field":"clock","present":false}]]);
    let mut pack=parse_hud_style_pack(&value).unwrap();
    let absent_mark=recognize_hud_frame(&frame,640,360,&pack,"official-top-360").unwrap();
    assert!(matches!(absent_mark.fields.clock,HudFieldResult::Read{..}));
    assert!(matches!(absent_mark.states["planted"],HudPresenceResult::NotMatched{..}));
    let mut bomb_frame=frame;
    for (i,pixel) in [255,0,255,0,255,0,255,0,255].iter().enumerate() {
        bomb_frame[(i/3*640+i%3)*4..(i/3*640+i%3)*4+3].fill(*pixel);
    }
    let bomb=recognize_hud_frame(&bomb_frame,640,360,&pack,"official-top-360").unwrap();
    assert!(matches!(bomb.fields.clock,HudFieldResult::Absent{..}));
    assert!(matches!(bomb.states["planted"],HudPresenceResult::Matched{..}));
    assert_eq!(bomb.phase,"planted");
    for cue_id in ["roundHistory","scoreboard"] {
        let mark=pack.variants[0].cues.remove("bomb").or_else(||pack.variants[0].cues.remove("roundHistory")).unwrap();
        pack.variants[0].cues.insert(cue_id.into(),mark);
        pack.variants[0].states.clear();
        pack.variants[0].states.insert(if cue_id=="roundHistory" {"round-history"} else {"scoreboard"}.into(),vec![vec![HudCondition::Cue{cue:cue_id.into(),present:true}]]);
        for side in ["scoreLeft","scoreRight"] {
            let mut field=pack.variants[0].fields.clock.as_ref().unwrap().clone();
            field.grammar=HudGrammar::Integer{min:0,max:99};
            field.glyphs.remove(":");
            if side=="scoreLeft" {pack.variants[0].fields.score_left=Some(field)} else {pack.variants[0].fields.score_right=Some(field)};
        }
        let stats=recognize_hud_frame(&bomb_frame,640,360,&pack,"official-top-360").unwrap();
        assert!(matches!(stats.fields.clock,HudFieldResult::Absent{..}));
        assert!(matches!(stats.fields.score_left,HudFieldResult::Absent{..}));
        assert!(matches!(stats.fields.score_right,HudFieldResult::Absent{..}));
        assert!(matches!(stats.fields.round,HudFieldResult::Indeterminate{..}));
        assert_eq!(stats.phase,"statistics");
    }
}

#[test]
fn shared_hud_schema_fixtures() {
    fn normalize_numbers(v:&mut Value) {
        if v.is_number() { *v=json!(v.as_f64().unwrap()); }
        else if let Some(map)=v.as_object_mut() { for child in map.values_mut(){normalize_numbers(child);} }
        else if let Some(array)=v.as_array_mut() { for child in array {normalize_numbers(child);} }
    }
    let cases:Value=serde_json::from_str(include_str!("../../../tests/fixtures/hud-style-pack/cases.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let issues=validate_hud_style_pack(&case["value"]);
        assert_eq!(issues.is_empty(),case["valid"].as_bool().unwrap(),"{}: {:?}",case["name"],issues);
        for path in case["paths"].as_array().unwrap() {assert!(issues.iter().any(|i|i.path==path.as_str().unwrap()),"{}: missing {} in {:?}",case["name"],path,issues);}
        if issues.is_empty() {
            let pack=parse_hud_style_pack(&case["value"]).unwrap();
            let mut actual=serde_json::to_value(&pack).unwrap(); let mut expected=case["value"].clone();
            normalize_numbers(&mut actual);normalize_numbers(&mut expected);
            assert_eq!(actual,expected,"{}: roundtrip",case["name"]);
        }
    }
}

#[test]
fn hud_integer_json_spellings_have_javascript_semantics() {
    let cases:Value=serde_json::from_str(include_str!("../../../tests/fixtures/hud-style-pack/cases.json")).unwrap();
    let mut pack=cases[1]["value"].clone();
    fn float_spellings(v:&mut Value) {
        if v.is_number() {*v=json!(v.as_f64().unwrap());}
        else if let Some(map)=v.as_object_mut(){for child in map.values_mut(){float_spellings(child);}}
        else if let Some(array)=v.as_array_mut(){for child in array {float_spellings(child);}}
    }
    float_spellings(&mut pack);
    assert!(parse_hud_style_pack(&pack).is_ok());
}

fn scoreboard(left: &str, right: &str) -> (Vec<u8>, HudStylePack) {
    let (mut frame, roi) = clock(left, 6);
    let (right_frame, right_roi) = clock(right, 6);
    let rect = roi_to_pixels(&right_roi, 640, 360);
    for y in rect.y as usize..(rect.y + rect.height) as usize {
        for x in rect.x as usize..(rect.x + rect.width) as usize {
            let from = (y * 640 + x) * 4;
            let to = (y * 640 + x + 150) * 4;
            frame[to..to + 4].copy_from_slice(&right_frame[from..from + 4]);
        }
    }
    let mut value = hud_pack(&profile(6, roi), 640, 360);
    let mut field = value["variants"][0]["fields"]["clock"].clone();
    field["grammar"] = json!({"kind":"integer","min":0,"max":99});
    field["glyphs"].as_object_mut().unwrap().remove(":");
    value["variants"][0]["fields"]["clock"] = Value::Null;
    value["variants"][0]["fields"]["scoreLeft"] = field.clone();
    field["roi"] = json!({"x":rect.x as usize + 150,"y":rect.y as usize,"w":rect.width as usize,"h":rect.height as usize});
    value["variants"][0]["fields"]["scoreRight"] = field;
    (frame, parse_hud_style_pack(&value).unwrap())
}

#[test]
fn score_fields_read_integers_and_derive_round_without_a_round_roi() {
    for (left, right) in [("0", "7"), ("8", "9"), ("10", "8"), ("60", "99"), ("99", "99")] {
        let (frame, mut pack) = scoreboard(left, right);
        pack.variants[0].fields.score_left.as_mut().unwrap().preprocess.threshold = 75.0;
        pack.variants[0].fields.score_right.as_mut().unwrap().preprocess.threshold = 110.0;
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        for (field, text) in [(&result.fields.score_left, left), (&result.fields.score_right, right)] {
            let HudFieldResult::Read { reading, .. } = field else { panic!("{text}: {field:?}") };
            assert_eq!(reading.text, text);
            assert_eq!(reading.source, "recognized");
        }
        let HudFieldResult::Read { reading, debug } = &result.fields.round else { panic!("{result:?}") };
        assert_eq!(reading.value, left.parse::<f64>().unwrap() + right.parse::<f64>().unwrap() + 1.0);
        assert_eq!(reading.source, "derived");
        assert!(debug.is_none());
        let prepared = prepare_hud_glyphs(&frame, 640, 360, &pack, "official-top-360", "scoreRight").unwrap();
        let HudFieldResult::Read { debug: Some(debug), .. } = &result.fields.score_right else { unreachable!() };
        assert_eq!(prepared.roi_pixels, debug.roi_pixels);
        assert_eq!(prepared.normalized, debug.normalized);
        assert!(prepare_hud_glyphs(&frame, 640, 360, &pack, "official-top-360", "round").is_err());
        pack.variants[0].fields.score_left.as_mut().unwrap().preprocess.scale = 1.0;
        pack.variants[0].fields.score_left.as_mut().unwrap().preprocess.threshold = 255.0;
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        assert!(matches!(result.fields.score_left, HudFieldResult::Failed { .. }));
        assert!(matches!(result.fields.score_right, HudFieldResult::Read { .. }));
        assert!(matches!(result.fields.round, HudFieldResult::Failed { .. }));
    }
}

#[test]
fn scores_reject_leading_zero_long_numbers_and_out_of_range_values() {
    for text in ["00", "01", "001", "100"] {
        let (frame, pack) = scoreboard(text, "7");
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        assert!(matches!(result.fields.score_left, HudFieldResult::Failed { ref reason, .. } if reason == "invalid-format"), "{text}: {result:?}");
        assert!(matches!(result.fields.round, HudFieldResult::Failed { .. }));
    }
    let (frame, mut pack) = scoreboard("8", "7");
    pack.variants[0].fields.score_left.as_mut().unwrap().grammar = HudGrammar::Integer { min: 0, max: 7 };
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.score_left, HudFieldResult::Failed { ref reason, .. } if reason == "invalid-format"));
}

#[test]
fn partial_score_banks_reject_missing_digits_instead_of_using_similar_known_digits() {
    for digit in 0..10 {
        let text = digit.to_string();
        let (frame, mut pack) = scoreboard(&text, &text);
        pack.variants[0].fields.score_left.as_mut().unwrap().glyphs.retain(|c, _| ["0", "1", "8", "9"].contains(&c.as_str()));
        pack.variants[0].fields.score_right.as_mut().unwrap().glyphs.retain(|c, _| ["7", "8"].contains(&c.as_str()));
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        for field in [&result.fields.score_left, &result.fields.score_right] {
            if [0, 1, 7, 8, 9].contains(&digit) {
                let HudFieldResult::Read { reading, .. } = field else { panic!("{text}: {field:?}") };
                assert_eq!(reading.text, text);
            } else {
                assert!(matches!(field, HudFieldResult::Failed { reason, .. } if reason == "missing-glyph"), "{text}: {field:?}");
            }
        }
    }
}

#[test]
fn shared_score_glyphs_read_both_sides_with_only_one_side_trained() {
    for train_left in [true, false] {
        let (frame, mut pack) = scoreboard("18", "9");
        let fields = &mut pack.variants[0].fields;
        let (trained, untrained) = if train_left {
            (fields.score_left.as_mut().unwrap(), fields.score_right.as_mut().unwrap())
        } else {
            (fields.score_right.as_mut().unwrap(), fields.score_left.as_mut().unwrap())
        };
        trained.glyphs.retain(|c, _| ["1", "8", "9"].contains(&c.as_str()));
        untrained.glyphs.clear();
        let before = serde_json::to_value(&pack).unwrap();
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        for (field, expected) in [(&result.fields.score_left, "18"), (&result.fields.score_right, "9")] {
            let HudFieldResult::Read { reading, .. } = field else { panic!("{field:?}") };
            assert_eq!(reading.text, expected);
        }
        assert_eq!(serde_json::to_value(&pack).unwrap(), before);
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
        assert!(matches!(result.fields.round, HudFieldResult::Read { ref reading, .. } if reading.value == 28.0));
    }
}

#[test]
fn shared_score_glyphs_keep_color_preprocessing_matching_and_grammar_independent() {
    let (mut frame, mut pack) = scoreboard("18", "18");
    let fields = &mut pack.variants[0].fields;
    for (left_side, field) in [
        (true, fields.score_left.as_mut().unwrap()),
        (false, fields.score_right.as_mut().unwrap()),
    ] {
        for y in field.roi.y..field.roi.y + field.roi.h {
            for x in field.roi.x..field.roi.x + field.roi.w {
                let pixel = &mut frame[(y * 640 + x) * 4..(y * 640 + x) * 4 + 4];
                let foreground = pixel[0] > 200;
                pixel.copy_from_slice(match (left_side, foreground) {
                    (true, true) => &[60, 180, 220, 255],
                    (true, false) => &[8, 10, 14, 255],
                    (false, true) => &[22, 12, 35, 255],
                    (false, false) => &[245, 235, 215, 255],
                });
            }
        }
        field.preprocess = HudPreprocessSettings { scale: 1.0, threshold: if left_side { 80.0 } else { 200.0 }, invert: !left_side, ..HudPreprocessSettings::default() };
        if !left_side { field.glyphs.clear(); }
    }
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    for (field_id, result) in [("scoreLeft", &result.fields.score_left), ("scoreRight", &result.fields.score_right)] {
        let HudFieldResult::Read { reading, debug: Some(debug) } = result else { panic!("{result:?}") };
        assert_eq!(reading.text, "18");
        let prepared = prepare_hud_glyphs(&frame, 640, 360, &pack, "official-top-360", field_id).unwrap();
        assert_eq!(prepared.roi_pixels, debug.roi_pixels);
        assert_eq!(prepared.normalized, debug.normalized);
    }
    pack.variants[0].fields.score_right.as_mut().unwrap().grammar = HudGrammar::Integer { min: 0, max: 17 };
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.score_left, HudFieldResult::Read { .. }));
    assert!(matches!(result.fields.score_right, HudFieldResult::Failed { ref reason, .. } if reason == "invalid-format"));
    pack.variants[0].fields.score_left.as_mut().unwrap().preprocess.threshold = 255.0;
    pack.variants[0].fields.score_right.as_mut().unwrap().grammar = HudGrammar::Integer { min: 0, max: 99 };
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.score_left, HudFieldResult::Failed { .. }));
    assert!(matches!(result.fields.score_right, HudFieldResult::Read { .. }));
}

#[test]
fn shared_score_glyphs_do_not_enable_null_fields_or_borrow_other_layouts_and_clocks() {
    let (frame, mut pack) = scoreboard("8", "9");
    pack.variants[0].fields.score_right = None;
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.score_left, HudFieldResult::Read { .. }));
    assert!(matches!(result.fields.score_right, HudFieldResult::Failed { ref reason, .. } if reason == "not-configured"));

    let (frame, mut pack) = scoreboard("8", "9");
    let mut other = pack.variants[0].clone();
    other.id = "other-layout".into();
    pack.variants.push(other);
    pack.variants[0].fields.clock = pack.variants[0].fields.score_left.clone();
    pack.variants[0].fields.clock.as_mut().unwrap().grammar = HudGrammar::Countdown { format: "ss".into() };
    pack.variants[0].fields.score_left.as_mut().unwrap().glyphs.clear();
    pack.variants[0].fields.score_right.as_mut().unwrap().glyphs.clear();
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.clock, HudFieldResult::Read { .. }));
    for field in [&result.fields.score_left, &result.fields.score_right] {
        assert!(matches!(field, HudFieldResult::Failed { reason, .. } if reason == "missing-glyph"));
    }
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "other-layout").unwrap();
    assert!(matches!(result.fields.score_left, HudFieldResult::Read { .. }));
    assert!(matches!(result.fields.score_right, HudFieldResult::Read { .. }));
    pack.variants[0].fields.score_left = pack.variants[1].fields.score_left.clone();
    pack.variants[0].fields.clock.as_mut().unwrap().glyphs.clear();
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.clock, HudFieldResult::Failed { ref reason, .. } if reason == "insufficient-templates"));
    assert!(matches!(result.fields.score_left, HudFieldResult::Read { .. }));
    assert!(matches!(result.fields.score_right, HudFieldResult::Read { .. }));
}

#[test]
fn hud_preprocess_modes_use_identical_masks_for_fields_cues_and_recognition() {
    let (original, roi) = clock("1:37", 6);
    for mode in [HudPreprocessMode::Gray, HudPreprocessMode::Adaptive, HudPreprocessMode::Hsv] {
        let mut frame = original.clone();
        let mut pack = parse_hud_style_pack(&hud_pack(&profile(6, roi.clone()), 640, 360)).unwrap();
        let field = pack.variants[0].fields.clock.as_mut().unwrap();
        field.preprocess.mode = mode;
        field.preprocess.scale = 1.0;
        field.preprocess.adaptive.window_size = 31;
        field.preprocess.adaptive.offset = 7.0;
        if mode == HudPreprocessMode::Hsv {
            // Both colors become gray 18, so only the original RGB can separate the glyphs.
            for y in field.roi.y..field.roi.y + field.roi.h {
                for x in field.roi.x..field.roi.x + field.roi.w {
                    let pixel = &mut frame[(y * 640 + x) * 4..(y * 640 + x) * 4 + 4];
                    let ink = pixel[0] > 200;
                    pixel.copy_from_slice(if ink { &[60, 0, 0, 255] } else { &[0, 0, 160, 255] });
                }
            }
        }
        let cue = HudCue { enabled: true, roi: field.roi.clone(), preprocess: field.preprocess.clone(), templates: vec![], min_score: 1.0 };
        pack.variants[0].cues.insert("replay".into(), cue.clone());
        pack.variants[0].organizer = Some(cue);
        let prepared = prepare_hud_glyphs(&frame, 640, 360, &pack, "official-top-360", "clock").unwrap();
        let mark = prepare_hud_cue(&frame, 640, 360, &pack, "official-top-360", "replay").unwrap();
        assert_eq!(prepared.gray, mark.gray);
        assert_eq!(prepared.binary, mark.binary);
        assert_eq!(prepared.boxes.len(), 4, "{mode:?}");
        pack.bitmaps.insert("same-region".into(), HudBitmap { width: mark.binary.width, height: mark.binary.height, data: mark.bitmap });
        pack.variants[0].cues.get_mut("replay").unwrap().templates = vec!["same-region".into()];
        pack.variants[0].organizer.as_mut().unwrap().templates = vec!["same-region".into()];
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        let HudFieldResult::Read { reading, debug: Some(debug) } = &result.fields.clock else { panic!("{mode:?}: {result:?}") };
        assert_eq!(reading.text, "1:37");
        assert_eq!(debug.binary, prepared.binary);
        assert_eq!(debug.normalized, prepared.normalized);
        assert!(matches!(result.cues["replay"], HudPresenceResult::Matched { score: Some(1.0), .. }));
        assert!(matches!(result.organizer, HudPresenceResult::Matched { score: Some(1.0), .. }));
        assert!(validate_hud_style_pack(&serde_json::to_value(&pack).unwrap()).is_empty());
    }
}

#[test]
fn hud_preprocess_parser_requires_the_unique_complete_settings_format() {
    let (_, pack) = scoreboard("8", "9");
    let value = serde_json::to_value(&pack).unwrap();
    for (pointer, replacement) in [
        ("/mode", json!("rgb")), ("/scale", json!(0)), ("/scale", json!(11)),
        ("/threshold", json!(-1)), ("/threshold", json!(256)), ("/invert", json!(1)),
        ("/adaptive/windowSize", json!(2)), ("/adaptive/windowSize", json!(4)),
        ("/adaptive/windowSize", json!(257)), ("/adaptive/windowSize", json!(3.5)),
        ("/adaptive/offset", json!(-1)), ("/adaptive/offset", json!(129)),
        ("/hsv/hue", json!(-0.1)), ("/hsv/hue", json!(360)),
        ("/hsv/tolerance", json!(181)), ("/hsv/saturationMin", json!(1.1)),
        ("/hsv/saturationMax", json!(-0.1)), ("/hsv/valueMin", json!(-1)),
        ("/hsv/valueMax", json!(1.1)), ("/hsv/saturationMax", json!(0.1)),
        ("/hsv/valueMax", json!(0.01)),
    ] {
        let mut invalid = value.clone();
        let preprocess = &mut invalid["variants"][0]["fields"]["scoreLeft"]["preprocess"];
        *preprocess.pointer_mut(pointer).unwrap() = replacement;
        let issues = validate_hud_style_pack(&invalid);
        assert!(!issues.is_empty(), "{pointer}: {invalid}");
        assert!(issues.iter().all(|issue| issue.path.starts_with("variants[0].fields.scoreLeft.preprocess")));
    }
    for missing in ["mode", "adaptive", "hsv"] {
        let mut invalid = value.clone();
        invalid["variants"][0]["fields"]["scoreLeft"]["preprocess"].as_object_mut().unwrap().remove(missing);
        assert!(parse_hud_style_pack(&invalid).is_err());
    }
    for pointer in ["", "/adaptive", "/hsv"] {
        let mut invalid = value.clone();
        invalid["variants"][0]["fields"]["scoreLeft"]["preprocess"].pointer_mut(pointer).unwrap()
            .as_object_mut().unwrap().insert("unknown".into(), json!(0));
        assert!(parse_hud_style_pack(&invalid).is_err());
    }
    let mut old = value.clone();
    old["variants"][0]["fields"]["scoreLeft"]["preprocess"] = json!({"scale":1.4,"threshold":150,"invert":false});
    assert!(parse_hud_style_pack(&old).is_err());
    let mut valid = value;
    valid["variants"][0]["fields"]["scoreLeft"]["preprocess"]["adaptive"]["windowSize"] = json!(255.0);
    valid["variants"][0]["fields"]["scoreLeft"]["preprocess"]["hsv"]["hue"] = json!(359.999);
    assert!(parse_hud_style_pack(&valid).is_ok());
}

#[test]
fn hud_preprocess_recommendations_resolve_full_frame_coordinates_and_reject_invalid_targets() {
    let (frame, mut pack) = scoreboard("8", "9");
    let field = pack.variants[0].fields.score_left.as_ref().unwrap();
    let roi = field.roi.clone();
    pack.variants[0].organizer = Some(HudCue { enabled: true, roi: field.roi.clone(), preprocess: field.preprocess.clone(), templates: vec![], min_score: 0.9 });
    for target in ["scoreLeft", "organizer"] {
        let recommended = recommend_hud_preprocess(&frame, 640, 360, &pack, "official-top-360", target,
            &HudPreprocessRequest::Hsv { x: 287, y: 21 }).unwrap();
        let settings = recommended.settings.unwrap();
        assert_eq!(settings.mode, HudPreprocessMode::Hsv);
        assert!(settings.validate().is_ok());
        for (x, y) in [(roi.x - 1, roi.y), (roi.x + roi.w, roi.y), (roi.x, roi.y - 1), (roi.x, roi.y + roi.h)] {
            assert!(recommend_hud_preprocess(&frame, 640, 360, &pack, "official-top-360", target,
                &HudPreprocessRequest::Hsv { x, y }).is_err());
        }
        assert!(recommend_hud_preprocess(&frame, 640, 359, &pack, "official-top-360", target, &HudPreprocessRequest::Polarity {}).is_err());
    }
    for target in ["clock", "missing", "round"] {
        assert!(recommend_hud_preprocess(&frame, 640, 360, &pack, "official-top-360", target, &HudPreprocessRequest::Polarity {}).is_err());
    }
    assert!(recommend_hud_preprocess(&frame, 640, 360, &pack, "missing", "scoreLeft", &HudPreprocessRequest::Polarity {}).is_err());
    assert!(recommend_hud_preprocess(&frame[..frame.len() - 1], 640, 360, &pack, "official-top-360", "scoreLeft", &HudPreprocessRequest::Polarity {}).is_err());
}

#[test]
fn disabled_clock_keeps_templates_and_stats_but_skips_reading_and_editor_operations() {
    let (frame, roi) = clock("1:37", 6);
    let mut pack = parse_hud_style_pack(&hud_pack(&profile(6, roi), 640, 360)).unwrap();
    let before = serde_json::to_value(&pack).unwrap();
    let ready = hud_pack_readiness(&pack, "official-top-360");
    assert_eq!(ready["ready"], true);
    pack.variants[0].fields.clock.as_mut().unwrap().enabled = false;
    let disabled_snapshot = serde_json::to_value(&pack).unwrap();
    let readiness = hud_pack_readiness(&pack, "official-top-360");
    assert_eq!(readiness["ready"], false);
    assert_eq!(readiness["missing"], ready["missing"]);
    assert_eq!(readiness["sampleCount"], ready["sampleCount"]);
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.clock, HudFieldResult::Disabled { debug: None }));
    assert_eq!(serde_json::to_value(&result.fields.clock).unwrap(), json!({"status":"disabled","debug":null}));
    assert_eq!(prepare_hud_glyphs(&frame, 640, 360, &pack, "official-top-360", "clock").unwrap_err(), "field-disabled");
    assert_eq!(recommend_hud_preprocess(&frame, 640, 360, &pack, "official-top-360", "clock", &HudPreprocessRequest::Polarity {}).unwrap_err(), "field-disabled");
    let mut engine = Engine::new();
    assert_eq!(engine.configure(&serde_json::to_string(&pack).unwrap()).unwrap()["ready"], false);
    assert_eq!(engine.recognize(&frame, 640, 360, 0.0, 0.0, 0.0, true)["outcome"], json!({"status":"disabled"}));
    assert_eq!(serde_json::to_value(&pack).unwrap(), disabled_snapshot);
    pack.variants[0].fields.clock.as_mut().unwrap().enabled = true;
    assert_eq!(serde_json::to_value(&pack).unwrap(), before);
    assert!(matches!(recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap().fields.clock, HudFieldResult::Read { .. }));
}

#[test]
fn disabled_cues_and_organizer_never_hide_or_invalidate_the_clock() {
    let (mut frame, mut pack) = layout_pack();
    pack.variants.truncate(1);
    paint_layout_mark(&mut frame, 7);
    let mut mark = pack.variants[0].organizer.as_ref().unwrap().clone();
    mark.enabled = false;
    pack.variants[0].organizer = Some(mark.clone());
    for id in ["replay", "bomb", "timeout", "roundOver", "roundHistory", "scoreboard"] {
        pack.variants[0].cues.insert(id.into(), mark.clone());
    }
    for (state, cue) in [("replay", "replay"), ("planted", "bomb"), ("paused", "timeout"), ("round-over", "roundOver"), ("statistics", "scoreboard")] {
        pack.variants[0].states.insert(state.into(), vec![vec![HudCondition::Cue { cue: cue.into(), present: true }]]);
    }
    pack.variants[0].states.insert("active".into(), vec![vec![HudCondition::Cue { cue: "bomb".into(), present: false }]]);
    let before = serde_json::to_value(&pack).unwrap();
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert!(matches!(result.fields.clock, HudFieldResult::Read { .. }));
    assert_eq!(result.content, "live");
    assert_eq!(result.phase, "unconfigured");
    for result in result.cues.values().chain(result.states.values()).chain(std::iter::once(&result.organizer)) {
        assert!(matches!(result, HudPresenceResult::Disabled { score: None, debug: None }));
        assert_eq!(serde_json::to_value(result).unwrap(), json!({"status":"disabled","score":null,"debug":null}));
    }
    for id in ["replay", "organizer"] {
        assert_eq!(prepare_hud_cue(&frame, 640, 360, &pack, "official-top-360", id).unwrap_err(), "field-disabled");
        assert_eq!(recommend_hud_preprocess(&frame, 640, 360, &pack, "official-top-360", id, &HudPreprocessRequest::Threshold {}).unwrap_err(), "field-disabled");
    }
    assert_eq!(serde_json::to_value(&pack).unwrap(), before);
    pack.variants[0].cues.get_mut("replay").unwrap().enabled = true;
    let replay = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_eq!(replay.content, "replay");
    assert!(matches!(replay.fields.clock, HudFieldResult::Read { .. }));
    pack.variants[0].cues.get_mut("bomb").unwrap().enabled = true;
    let planted = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert!(matches!(planted.fields.clock, HudFieldResult::Absent { .. }));
    pack.variants[0].fields.clock.as_mut().unwrap().enabled = false;
    assert!(matches!(recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap().fields.clock, HudFieldResult::Disabled { debug: None }));
}

#[test]
fn disabled_scores_do_not_read_derive_round_or_supply_unshared_glyphs() {
    let (frame, mut pack) = scoreboard("8", "9");
    let original = serde_json::to_value(&pack).unwrap();
    pack.variants[0].fields.score_left.as_mut().unwrap().enabled = false;
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.score_left, HudFieldResult::Disabled { debug: None }));
    assert!(matches!(result.fields.score_right, HudFieldResult::Read { .. }));
    assert!(matches!(result.fields.round, HudFieldResult::Disabled { debug: None }));
    let shared_right = pack.variants[0].fields.score_right.as_ref().unwrap().glyphs.clone();
    pack.variants[0].fields.score_right.as_mut().unwrap().glyphs.clear();
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(result.fields.score_right, HudFieldResult::Failed { ref reason, .. } if reason == "missing-glyph"));
    pack.variants[0].fields.score_right.as_mut().unwrap().glyphs = shared_right;
    pack.variants[0].fields.score_left.as_mut().unwrap().enabled = true;
    assert_eq!(serde_json::to_value(&pack).unwrap(), original);
    assert!(matches!(recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap().fields.round, HudFieldResult::Read { .. }));
}

#[test]
fn disabled_organizers_are_excluded_from_multi_layout_selection_but_not_single_fallback() {
    let (mut frame, mut pack) = layout_pack();
    paint_layout_mark(&mut frame, 7);
    paint_layout_mark(&mut frame, 21);
    pack.variants[0].organizer.as_mut().unwrap().enabled = false;
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_eq!(result.variant_id.as_deref(), Some("official-bottom-360"));
    pack.variants[1].organizer.as_mut().unwrap().enabled = false;
    assert_indeterminate_layout(&recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap(), "no-match");
    let explicit = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
    assert!(matches!(explicit.fields.clock, HudFieldResult::Read { .. }));
    assert!(matches!(explicit.organizer, HudPresenceResult::Disabled { .. }));
    pack.variants.truncate(1);
    let result = recognize_hud_frame(&frame, 640, 360, &pack, "").unwrap();
    assert_eq!(result.variant_id.as_deref(), Some("official-top-360"));
    assert!(matches!(result.fields.clock, HudFieldResult::Read { .. }));
}

#[test]
fn enabled_is_required_boolean_and_disabled_configuration_remains_strictly_validated() {
    let (_, pack) = layout_pack();
    let base = serde_json::to_value(&pack).unwrap();
    for target in ["/variants/0/fields/clock", "/variants/0/organizer"] {
        for enabled in [Value::Null, json!(0), json!(1), json!("false")] {
            let mut invalid = base.clone();
            invalid.pointer_mut(target).unwrap()["enabled"] = enabled;
            assert!(parse_hud_style_pack(&invalid).is_err(), "{invalid}");
        }
        let mut invalid = base.clone();
        invalid.pointer_mut(target).unwrap().as_object_mut().unwrap().remove("enabled");
        assert!(parse_hud_style_pack(&invalid).is_err());
        for property in ["roi", "preprocess"] {
            let mut invalid = base.clone();
            let item = invalid.pointer_mut(target).unwrap();
            item["enabled"] = json!(false);
            item[property] = json!({});
            assert!(parse_hud_style_pack(&invalid).is_err());
        }
        let mut valid = base.clone();
        valid.pointer_mut(target).unwrap()["enabled"] = json!(false);
        let parsed = parse_hud_style_pack(&valid).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap().pointer(target).unwrap()["enabled"], false);
    }
}

fn team_timeout_fixture(left: bool, right: bool) -> (Vec<u8>, HudStylePack) {
    let (mut frame, roi) = clock("1:37", 6);
    let mut value = hud_pack(&profile(6, roi), 640, 360);
    for (id, x, present, mask, inverted) in [
        ("timeout", 7, left, [255, 0, 255, 0, 255, 0, 255, 0, 255], false),
        ("timeoutRight", 500, right, [0, 255, 0, 255, 255, 255, 0, 255, 0], true),
    ] {
        let bitmap_id = if inverted { "right-timeout" } else { "left-timeout" };
        value["bitmaps"][bitmap_id] = json!({"width":3,"height":3,"data":pack_bitmap(&mask)});
        value["variants"][0]["cues"][id] = json!({
            "enabled":true,"roi":{"x":x,"y":80,"w":3,"h":3},
            "preprocess":HudPreprocessSettings { scale:1.0, threshold: if inverted {80.0} else {100.0}, invert:inverted, ..HudPreprocessSettings::default() },
            "templates":[bitmap_id],"minScore":1.0,
        });
        for (i, &ink) in mask.iter().enumerate() {
            let selected = present && ink != 0;
            let color = match (inverted, selected) {
                (false, true) => [200, 90, 40, 255],
                (false, false) => [12, 14, 18, 255],
                (true, true) => [12, 25, 85, 255],
                (true, false) => [240, 230, 220, 255],
            };
            let offset = ((80 + i / 3) * 640 + x + i % 3) * 4;
            frame[offset..offset + 4].copy_from_slice(&color);
        }
    }
    value["variants"][0]["states"]["active"] = json!([[{"kind":"field","field":"clock","present":true}]]);
    (frame, parse_hud_style_pack(&value).unwrap())
}

#[test]
fn team_timeouts_read_independent_positions_colors_and_templates_and_pause_on_either_side() {
    assert!(HUD_CUES.contains(&"timeoutRight"));
    for (left, right) in [(false, false), (true, false), (false, true), (true, true)] {
        let (frame, pack) = team_timeout_fixture(left, right);
        let before = serde_json::to_value(&pack).unwrap();
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        assert_eq!(result.phase, if left || right { "paused" } else { "active" });
        assert!(matches!(result.fields.clock, HudFieldResult::Read { ref reading, .. } if reading.text == "1:37"));
        assert!(matches!(result.states["active"], HudPresenceResult::Matched { .. }));
        for (id, expected, x) in [("timeout", left, 7.0), ("timeoutRight", right, 500.0)] {
            assert_eq!(matches!(result.cues[id], HudPresenceResult::Matched { .. }), expected);
            assert_eq!(matches!(result.cues[id], HudPresenceResult::NotMatched { .. }), !expected);
            let prepared = prepare_hud_cue(&frame, 640, 360, &pack, "official-top-360", id).unwrap();
            assert_eq!(prepared.roi_pixels.x, x);
            if expected {
                let template = &pack.variants[0].cues[id].templates[0];
                assert_eq!(prepared.bitmap, pack.bitmaps[template].data);
            }
        }
        assert_eq!(serde_json::to_value(&pack).unwrap(), before);
    }
}

#[test]
fn disabling_or_removing_one_team_timeout_does_not_disable_the_other() {
    for disabled_side in ["timeout", "timeoutRight"] {
        let enabled_side = if disabled_side == "timeout" { "timeoutRight" } else { "timeout" };
        let (frame, mut pack) = team_timeout_fixture(true, true);
        pack.variants[0].cues.get_mut(disabled_side).unwrap().enabled = false;
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        assert_eq!(result.phase, "paused");
        assert!(matches!(result.cues[disabled_side], HudPresenceResult::Disabled { score: None, debug: None }));
        assert!(matches!(result.cues[enabled_side], HudPresenceResult::Matched { .. }));
        pack.variants[0].cues.remove(disabled_side);
        assert!(validate_hud_style_pack(&serde_json::to_value(&pack).unwrap()).is_empty());
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        assert_eq!(result.phase, "paused");
        assert!(!result.cues.contains_key(disabled_side));
        pack.variants[0].cues.get_mut(enabled_side).unwrap().enabled = false;
        assert_eq!(recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap().phase, "active");
    }
}

#[test]
fn unreadable_team_timeout_preserves_other_positive_evidence_and_strict_rule_dependencies() {
    for unreadable in ["timeout", "timeoutRight"] {
        let (frame, mut pack) = team_timeout_fixture(true, true);
        pack.variants[0].cues.get_mut(unreadable).unwrap().templates.clear();
        pack.variants[0].states.insert("paused".into(), vec![
            vec![HudCondition::Cue { cue:"timeout".into(), present:true }],
            vec![HudCondition::Cue { cue:"timeoutRight".into(), present:true }],
        ]);
        pack.variants[0].states.insert("negative-check".into(), vec![vec![HudCondition::Cue { cue:unreadable.into(), present:false }]]);
        assert!(validate_hud_style_pack(&serde_json::to_value(&pack).unwrap()).is_empty());
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        assert_eq!(result.phase, "paused");
        assert!(matches!(result.cues[unreadable], HudPresenceResult::Failed { ref reason, .. } if reason == "insufficient-templates"));
        assert!(matches!(result.states["paused"], HudPresenceResult::Failed { .. }));
        assert!(matches!(result.states["negative-check"], HudPresenceResult::Failed { .. }));
        pack.variants[0].cues.get_mut(unreadable).unwrap().enabled = false;
        let result = recognize_hud_frame(&frame, 640, 360, &pack, "official-top-360").unwrap();
        assert_eq!(result.phase, "paused");
        assert!(matches!(result.states["paused"], HudPresenceResult::Matched { .. }));
        assert!(matches!(result.states["negative-check"], HudPresenceResult::Disabled { .. }));
    }
}
