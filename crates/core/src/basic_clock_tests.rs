use super::*;
use crate::pack_bitmap;

// Independent pixel shapes exercise geometry, temporal refusal and bounded cropping.
// Decoded system-font coverage is verified by the host integration tests.
const FONT: [[&str; 7]; 11] = [
    [
        "01110", "11011", "11011", "11011", "11011", "11011", "01110",
    ],
    [
        "00100", "01100", "00100", "00100", "00100", "00100", "01110",
    ],
    [
        "01110", "11011", "00011", "00110", "01100", "11000", "11111",
    ],
    [
        "11110", "00011", "00011", "01110", "00011", "00011", "11110",
    ],
    [
        "00011", "00111", "01111", "11011", "11111", "00011", "00011",
    ],
    [
        "11111", "11000", "11000", "11110", "00011", "00011", "11110",
    ],
    [
        "01110", "11000", "11000", "11110", "11011", "11011", "01110",
    ],
    [
        "11111", "00011", "00011", "00110", "00110", "01100", "01100",
    ],
    [
        "01110", "11011", "11011", "01110", "11011", "11011", "01110",
    ],
    [
        "01110", "11011", "11011", "01111", "00011", "00011", "01110",
    ],
    ["0", "1", "1", "0", "1", "1", "0"],
];
fn glyph(symbol: usize, scale: usize) -> Image {
    let rows = &FONT[symbol];
    let w = rows[0].len() * scale;
    let mut image = Image {
        data: vec![0; w * 7 * scale],
        width: w,
        height: 7 * scale,
    };
    for (y, row) in rows.iter().enumerate() {
        for (x, pixel) in row.bytes().enumerate() {
            if pixel == b'1' {
                for yy in 0..scale {
                    for xx in 0..scale {
                        image.data[(y * scale + yy) * w + x * scale + xx] = 255;
                    }
                }
            }
        }
    }
    image
}
fn templates() -> String {
    let mut result = BTreeMap::new();
    for (symbol, char) in CLOCK_CHARS.into_iter().enumerate() {
        result.insert(char, vec![pack_bitmap(&normalize_glyph(&glyph(symbol, 5)))]);
    }
    serde_json::to_string(&result).unwrap()
}
fn draw(image: &mut Image, text: &str, x: usize, y: usize, scale: usize) {
    let mut left = x;
    for char in text.chars() {
        let symbol = if char == ':' {
            10
        } else {
            char.to_digit(10).unwrap() as usize
        };
        let glyph = glyph(symbol, scale);
        for dy in 0..glyph.height {
            for dx in 0..glyph.width {
                if glyph.data[dy * glyph.width + dx] != 0 {
                    image.data[(y + dy) * image.width + left + dx] = 240;
                }
            }
        }
        left += glyph.width + scale * 2;
    }
}
fn frame(text: &str, second: Option<&str>) -> Vec<u8> {
    let mut image = Image {
        data: vec![12; 640 * 360],
        width: 640,
        height: 360,
    };
    draw(&mut image, text, 245, 25, 4);
    draw(&mut image, "12", 160, 25, 4);
    draw(&mut image, "9", 390, 25, 4);
    if let Some(text) = second {
        draw(&mut image, text, 245, 225, 4);
    }
    image
        .data
        .into_iter()
        .flat_map(|gray| [gray, gray, gray, 255])
        .collect()
}
fn push(recognizer: &mut BasicClockRecognizer, text: &str, time: f64) -> Value {
    recognizer.push(
        &frame(text, None),
        640,
        360,
        time,
        time * 1000.0 + 1000.0,
        time * 15.0,
        false,
    )
}

fn confirmed_clock() -> BasicClockRecognizer {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let mut result = Value::Null;
    for index in 0..34 {
        let time = index as f64 / 15.0;
        let value = 109 - time.floor() as usize;
        result = push(
            &mut recognizer,
            &format!("{}:{:02}", value / 60, value % 60),
            time,
        );
    }
    assert_eq!(result["outcome"]["status"], "success", "{result}");
    assert!(recognizer.track.as_ref().unwrap().layout.confirmed);
    recognizer
}

#[test]
fn timing_reset_retains_verified_layout_and_rebuilds_only_new_tick_evidence() {
    let mut recognizer = confirmed_clock();
    let layout = &recognizer.track.as_ref().unwrap().layout;
    let roi = roi_json(&layout.rect, 640, 360);
    let timing_roi = roi_json(&layout.timing_rect, 640, 360);
    let threshold = layout.threshold;
    recognizer.reset_timing();
    let track = recognizer.track.as_ref().unwrap();
    assert_eq!(roi_json(&track.layout.rect, 640, 360), roi);
    assert_eq!(roi_json(&track.layout.timing_rect, 640, 360), timing_roi);
    assert_eq!(track.layout.threshold, threshold);
    assert!(track.layout.confirmed);
    assert!(track.timing.value.is_none());
    assert!(track.timing.pending.is_none());
    assert!(track.timing.last_change.is_none());
    assert!(track.timing.pending_tick.is_none());
    assert_eq!(track.timing.decrements, 0);
    assert!(recognizer.last_time.is_none());
    let mut ticks = Vec::new();
    for index in 0..34 {
        let elapsed = index as f64 / 15.0;
        let value = 55 - elapsed.floor() as usize;
        let result = push(&mut recognizer, &format!("0:{value:02}"), 20.0 + elapsed);
        let restored_roi = &result["basic"]["roi"];
        if index == 0 {
            assert_eq!(*restored_roi, roi);
        } else {
            assert!(restored_roi["x"].as_f64().unwrap() <= roi["x"].as_f64().unwrap());
            assert!(
                restored_roi["x"].as_f64().unwrap() + restored_roi["w"].as_f64().unwrap()
                    >= roi["x"].as_f64().unwrap() + roi["w"].as_f64().unwrap()
            );
        }
        if index == 0 || index == 15 || index == 30 {
            assert_ne!(result["outcome"]["status"], "success", "{result}");
            assert!(result.get("tickMoment").is_none());
        } else {
            assert_eq!(result["outcome"]["status"], "success", "{result}");
            if let Some(tick) = result.get("tickMoment") {
                ticks.push(tick.clone());
                assert!(tick["lastUnchanged"].as_f64().unwrap() >= 20.0);
                assert!(index == 16 || index == 31);
            }
        }
        if index == 1 {
            assert_eq!(recognizer.track.as_ref().unwrap().timing.decrements, 0);
        }
        if index < 16 {
            assert!(result.get("tickMoment").is_none());
        }
    }
    assert_eq!(ticks.len(), 2, "{ticks:?}");
}

#[test]
fn same_size_gaps_rewinds_and_decode_failures_keep_only_verified_layout() {
    for boundary in [0.0, 20.0] {
        let mut recognizer = confirmed_clock();
        let roi = roi_json(&recognizer.track.as_ref().unwrap().layout.rect, 640, 360);
        let result = push(&mut recognizer, "0:48", boundary);
        assert_eq!(result["basic"]["text"], "0:48");
        assert_eq!(result["basic"]["roi"], roi);
        assert_ne!(result["outcome"]["status"], "success");
        assert!(recognizer.track.as_ref().unwrap().layout.confirmed);
        assert_eq!(recognizer.track.as_ref().unwrap().timing.decrements, 0);
        assert!(result.get("tickMoment").is_none());
    }
    let mut recognizer = confirmed_clock();
    let failed = recognizer.push(&[0; 3], 640, 360, 2.3, 2300.0, 35.0, false);
    assert_eq!(failed["outcome"]["reason"], "decode-failed");
    assert!(recognizer.track.as_ref().unwrap().layout.confirmed);
    let retry = push(&mut recognizer, "0:48", 2.4);
    assert_ne!(retry["outcome"]["status"], "success");
    let mut candidate = BasicClockRecognizer::new(&templates()).unwrap();
    push(&mut candidate, "1:49", 0.0);
    candidate.reset_timing();
    assert!(candidate.track.is_none());
}

#[test]
fn unreadable_or_ambiguous_cached_clocks_are_refused_without_forgetting_layout() {
    let mut recognizer = confirmed_clock();
    let roi = roi_json(&recognizer.track.as_ref().unwrap().layout.rect, 640, 360);
    for index in 0..30 {
        let time = 2.3 + index as f64 / 15.0;
        let result = recognizer.push(
            &vec![0; 640 * 360 * 4],
            640,
            360,
            time,
            time * 1000.0,
            40.0 + index as f64,
            false,
        );
        assert_ne!(result["outcome"]["status"], "success");
        assert_eq!(
            roi_json(&recognizer.track.as_ref().unwrap().layout.rect, 640, 360),
            roi
        );
    }
    let recovered = push(&mut recognizer, "0:48", 4.4);
    assert_eq!(recovered["basic"]["text"], "0:48");
    assert_ne!(recovered["outcome"]["status"], "success");
    let ambiguous = recognizer.push(
        &frame("0:48", Some("0:29")),
        640,
        360,
        5.2,
        5200.0,
        90.0,
        true,
    );
    assert_eq!(ambiguous["basic"]["status"], "ambiguous");
    assert_ne!(ambiguous["outcome"]["status"], "success");
    assert!(recognizer.track.as_ref().unwrap().layout.confirmed);
    assert_eq!(recognizer.track.as_ref().unwrap().timing.decrements, 0);
    assert_eq!(
        roi_json(&recognizer.track.as_ref().unwrap().layout.rect, 640, 360),
        roi
    );
}

#[test]
fn memory_promotion_reuses_verified_layout_and_real_source_resets_drop_it() {
    let mut recognizer = confirmed_clock();
    let roi = roi_json(&recognizer.track.as_ref().unwrap().layout.rect, 640, 360);
    let decrements = recognizer.track.as_ref().unwrap().timing.decrements;
    assert!(recognizer
        .set_roi_preserving_layout(&json!({"x":0.1,"y":0.1,"w":0.2,"h":0.2}).to_string())
        .is_err());
    assert!(recognizer.manual_roi.is_none());
    recognizer
        .set_roi_preserving_layout(&roi.to_string())
        .unwrap();
    assert_eq!(
        recognizer.track.as_ref().unwrap().timing.decrements,
        decrements
    );
    let result = push(&mut recognizer, "1:47", 2.3);
    assert_eq!(result["outcome"]["status"], "success", "{result}");
    recognizer.reset_timing();
    for index in 0..30 {
        let result = push(&mut recognizer, "1:47", 10.0 + index as f64 / 15.0);
        if index > 23 {
            assert_ne!(result["outcome"]["status"], "success");
        }
        assert!(result.get("tickMoment").is_none());
    }
    assert!(recognizer.track.as_ref().unwrap().layout.confirmed);
    recognizer.push(
        &vec![0; 320 * 180 * 4],
        320,
        180,
        12.1,
        12100.0,
        140.0,
        false,
    );
    assert!(recognizer.track.is_none());
    assert!(recognizer.manual_roi.is_some());
    recognizer.set_roi("null").unwrap();
    assert!(recognizer.manual_roi.is_none());
    assert!(recognizer.track.is_none());
}

#[test]
fn a_grown_envelope_keeps_the_same_inner_timing_region_after_memory_promotion() {
    let mut recognizer = confirmed_clock();
    let timing_roi = roi_json(
        &recognizer.track.as_ref().unwrap().layout.timing_rect,
        640,
        360,
    );
    push(&mut recognizer, "0:55", 3.0);
    assert_eq!(
        roi_json(
            &recognizer.track.as_ref().unwrap().layout.timing_rect,
            640,
            360
        ),
        timing_roi
    );
    let roi = roi_json(&recognizer.track.as_ref().unwrap().layout.rect, 640, 360);
    recognizer
        .set_roi_preserving_layout(&roi.to_string())
        .unwrap();
    recognizer.reset_timing();
    let mut ticks = Vec::new();
    for index in 0..34 {
        let elapsed = index as f64 / 15.0;
        let value = 55 - elapsed.floor() as usize;
        let result = push(&mut recognizer, &format!("0:{value:02}"), 10.0 + elapsed);
        assert_eq!(result["basic"]["roi"], roi);
        if let Some(tick) = result.get("tickMoment") {
            assert!(tick["lastUnchanged"].as_f64().unwrap() >= 10.0);
            ticks.push(tick.clone());
        }
    }
    assert_eq!(ticks.len(), 2, "{ticks:?}");
}

#[test]
fn discovers_only_clock_envelope_and_requires_real_decrements() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let first = push(&mut recognizer, "1:49", 0.0);
    assert_eq!(first["basic"]["status"], "confirming", "{first}");
    assert_ne!(first["outcome"]["status"], "success");
    let roi = &first["basic"]["roi"];
    assert!(roi["x"].as_f64().unwrap() > 0.35);
    assert!((roi["x"].as_f64().unwrap() + roi["w"].as_f64().unwrap()) < 0.60);
    let mut last = first;
    for frame in 1..50 {
        let time = frame as f64 / 15.0;
        let value = 109 - time.floor() as usize;
        last = push(
            &mut recognizer,
            &format!("{}:{:02}", value / 60, value % 60),
            time,
        );
    }
    assert_eq!(last["basic"]["status"], "locked", "{last}");
    assert_eq!(last["outcome"]["reading"]["seconds"], 106.0);
}

#[test]
fn static_and_blank_frames_never_become_sync_readings() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    for frame in 0..60 {
        let result = push(&mut recognizer, "1:49", frame as f64 / 15.0);
        assert_ne!(result["outcome"]["status"], "success");
    }
    let result = recognizer.push(&vec![0; 640 * 360 * 4], 640, 360, 4.1, 5100.0, 61.0, false);
    assert_eq!(result["basic"]["status"], "searching");
}

#[test]
fn two_valid_clock_regions_are_ambiguous() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let result = recognizer.push(
        &frame("1:49", Some("0:29")),
        640,
        360,
        0.0,
        1000.0,
        1.0,
        false,
    );
    assert_eq!(result["basic"]["status"], "ambiguous", "{result}");
    assert_ne!(result["outcome"]["status"], "success");
}

#[test]
fn round_reset_and_timestamp_rewind_revoke_confirmation() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    for frame in 0..50 {
        let time = frame as f64 / 15.0;
        let value = 109 - time.floor() as usize;
        push(
            &mut recognizer,
            &format!("{}:{:02}", value / 60, value % 60),
            time,
        );
    }
    push(&mut recognizer, "1:55", 3.4);
    let reset = push(&mut recognizer, "1:55", 3.5);
    assert_eq!(reset["basic"]["status"], "confirming", "{reset}");
    let rewind = push(&mut recognizer, "1:49", 0.0);
    assert_eq!(rewind["basic"]["status"], "confirming");
    recognizer.reset();
    assert_eq!(
        push(&mut recognizer, "1:49", 0.1)["basic"]["status"],
        "confirming"
    );
}

#[test]
fn rejects_invalid_templates_and_frames() {
    assert!(BasicClockRecognizer::new("{}").is_err());
    let mut raw: Value = serde_json::from_str(&templates()).unwrap();
    raw["0"][0] = json!("invalid");
    assert!(BasicClockRecognizer::new(&raw.to_string()).is_err());
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let result = recognizer.push(&[0; 3], 1, 1, 0.0, 0.0, 1.0, true);
    assert_eq!(result["outcome"]["reason"], "decode-failed");
    let result = recognizer.push(&[], usize::MAX, usize::MAX, 0.0, 0.0, 1.0, false);
    assert_eq!(result["outcome"]["reason"], "decode-failed");
}

#[test]
fn rejects_score_digits_attached_to_a_formal_round_clock() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    for index in 0..50 {
        let time = index as f64 / 15.0;
        let value = 109 - time.floor() as usize;
        let rgba = frame(&format!("{}:{:02}", value / 60, value % 60), None);
        let mut gray = Image {
            data: rgba.chunks_exact(4).map(|pixel| pixel[0]).collect(),
            width: 640,
            height: 360,
        };
        draw(&mut gray, "8", 341, 25, 4);
        let rgba: Vec<u8> = gray.data.into_iter().flat_map(|v| [v, v, v, 255]).collect();
        let result = recognizer.push(
            &rgba,
            640,
            360,
            time,
            1000.0 + time * 1000.0,
            index as f64,
            false,
        );
        assert_ne!(result["outcome"]["status"], "success", "{result}");
    }
    recognizer.reset();
    for index in 0..50 {
        let time = index as f64 / 15.0;
        let result = push(
            &mut recognizer,
            &format!("9:{:02}", 49 - time.floor() as usize),
            time,
        );
        assert_ne!(result["outcome"]["status"], "success", "{result}");
    }
}

#[test]
fn rejects_fast_decrements_and_revokes_a_held_clock() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    for index in 0..80 {
        let time = index as f64 / 30.0;
        let value = 109 - (time * 3.0).floor() as usize;
        let result = push(
            &mut recognizer,
            &format!("{}:{:02}", value / 60, value % 60),
            time,
        );
        assert_ne!(result["outcome"]["status"], "success", "{result}");
    }
    recognizer.reset();
    for index in 0..80 {
        let time = index as f64 / 15.0;
        let value = 109 - (time.min(3.0)).floor() as usize;
        let result = push(
            &mut recognizer,
            &format!("{}:{:02}", value / 60, value % 60),
            time,
        );
        if time > 4.5 {
            assert_ne!(result["outcome"]["status"], "success", "{result}");
        }
    }
}

#[test]
fn delayed_stable_reading_retains_pixel_jump_bracket() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let mut ticks = Vec::new();
    for index in 0..80 {
        let time = index as f64 / 15.0;
        let value = 109 - time.floor() as usize;
        let result = push(
            &mut recognizer,
            &format!("{}:{:02}", value / 60, value % 60),
            time,
        );
        if result.get("tickMoment").is_some() {
            ticks.push(result["tickMoment"].clone());
        }
    }
    assert!(ticks.len() >= 2, "{ticks:?}");
    for tick in ticks {
        assert!(tick["lastUnchanged"].as_f64().unwrap() < tick["firstChanged"].as_f64().unwrap());
    }
}

fn textured_frame(text: &str, seed: usize) -> Vec<u8> {
    let mut image = Image {
        data: vec![0; 1280 * 720],
        width: 1280,
        height: 720,
    };
    for y in 0..image.height {
        for x in 0..image.width {
            let noise = (x.wrapping_mul(17) ^ y.wrapping_mul(31) ^ x.wrapping_mul(y + seed)) % 220;
            image.data[y * image.width + x] = noise as u8;
        }
    }
    for y in 24..100 {
        for x in 400..800 {
            image.data[y * image.width + x] = 12;
        }
    }
    draw(&mut image, text, 520, 36, 6);
    image
        .data
        .into_iter()
        .flat_map(|v| [v, v, v, 255])
        .collect()
}

#[test]
#[ignore = "manual hot-path timing, run with --release --ignored --nocapture"]
fn benchmark_basic_clock_hot_paths() {
    use std::time::Instant;
    let mut many: BTreeMap<String, Vec<String>> = serde_json::from_str(&templates()).unwrap();
    for samples in many.values_mut() {
        let original = unpack_bitmap(&samples[0], 1536).unwrap();
        *samples = (0..32)
            .map(|index| {
                let mut mask = original.clone();
                if index > 0 {
                    mask[index * 41 % 1536] ^= 255;
                }
                pack_bitmap(&mask)
            })
            .collect();
    }
    let recognizer = BasicClockRecognizer::new(&serde_json::to_string(&many).unwrap()).unwrap();
    let rgba = textured_frame("1:49", 7);
    let rect = Rect {
        x: 514.0,
        y: 30.0,
        width: 156.0,
        height: 54.0,
    };
    let start = Instant::now();
    for _ in 0..8 {
        std::hint::black_box(recognizer.discover(&rgba, 1280, 720, false));
    }
    let discovery_ms = start.elapsed().as_secs_f64() * 1000.0 / 8.0;
    let start = Instant::now();
    let mut success = 0;
    for _ in 0..80 {
        success += recognizer
            .read_rect(&rgba, 1280, 720, &rect, false)
            .is_some() as usize;
    }
    let local_ms = start.elapsed().as_secs_f64() * 1000.0 / 80.0;
    println!("basic-clock benchmark: discovery_ms={discovery_ms:.3}, local_ms={local_ms:.3}, local_reads={success}");
    assert_eq!(success, 80);
}

#[test]
fn packed_matching_is_exactly_equivalent_and_debug_is_opt_in() {
    for left_seed in 0..8 {
        let left: Vec<_> = (0..1536)
            .map(|index| {
                if (index * 13 + left_seed * 7) % 19 < 8 {
                    255
                } else {
                    0
                }
            })
            .collect();
        for right_seed in 0..8 {
            let right: Vec<_> = (0..1536)
                .map(|index| {
                    if (index * 29 + right_seed * 11) % 23 < 9 {
                        255
                    } else {
                        0
                    }
                })
                .collect();
            assert_eq!(
                PackedMask::new(&left).score(&PackedMask::new(&right)),
                crate::score_masks(&left, &right)
            );
        }
    }
    let rgba = frame("1:49", None);
    let recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let with_debug = recognizer.discover(&rgba, 640, 360, true);
    let without_debug = recognizer.discover(&rgba, 640, 360, false);
    assert_eq!(with_debug.len(), 1);
    assert_eq!(without_debug.len(), 1);
    assert_eq!(with_debug[0].text, without_debug[0].text);
    assert_eq!(with_debug[0].scores, without_debug[0].scores);
    assert!(without_debug[0].debug.is_null());
    assert!(with_debug[0].debug["normalized"]
        .as_array()
        .is_some_and(|glyphs| glyphs.len() == 4));
}

#[test]
fn scanline_components_preserve_diagonal_connectivity_and_ink() {
    let mut image = Image {
        data: vec![0; 64 * 48],
        width: 64,
        height: 48,
    };
    for offset in 0..8 {
        image.data[(offset + 2) * image.width + offset + 3] = 255;
    }
    // Two arms join at their lower end; the merged pixels must be counted once.
    for y in 20..28 {
        image.data[y * image.width + 30] = 255;
        image.data[y * image.width + 36] = 255;
    }
    for x in 30..37 {
        image.data[27 * image.width + x] = 255;
    }
    let found = components(&image);
    assert_eq!(found.len(), 2);
    assert!(found.iter().any(|component| component.x == 3
        && component.y == 2
        && component.w == 8
        && component.h == 8
        && component.ink == 8));
    assert!(found.iter().any(|component| component.x == 30
        && component.y == 20
        && component.w == 7
        && component.h == 8
        && component.ink == 21));
}

#[test]
fn sparse_irregular_frames_still_confirm_real_seconds() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let mut accepted = Vec::new();
    for time in [
        0.0_f64, 0.19, 0.46, 0.73, 0.97, 1.21, 1.49, 1.76, 2.02, 2.31, 2.62, 2.91, 3.18, 3.46,
        3.77, 4.04, 4.33, 4.61, 4.90,
    ] {
        let seconds = 109 - time.floor() as usize;
        let result = push(
            &mut recognizer,
            &format!("{}:{:02}", seconds / 60, seconds % 60),
            time,
        );
        if result["outcome"]["status"] == "success" {
            assert_eq!(result["outcome"]["reading"]["seconds"], seconds as f64);
            accepted.push(seconds);
        }
    }
    assert!(accepted.contains(&107) && accepted.contains(&106) && accepted.contains(&105));
}

#[test]
fn integer_thresholds_match_generic_preprocessing_for_every_luminance() {
    let gray = Image {
        data: (0..=255).collect(),
        width: 256,
        height: 1,
    };
    for threshold in [180, 135, 215] {
        assert_eq!(
            threshold_gray(&gray, threshold),
            crate::binarize(
                &gray,
                &crate::PreprocessSettings {
                    scale: 1.0,
                    threshold: threshold as f64,
                    invert: false,
                }
            )
        );
    }
}

fn joined_seconds_frame(last: &str, extra: bool) -> Vec<u8> {
    let mut image = Image {
        data: vec![12; 640 * 360],
        width: 640,
        height: 360,
    };
    draw(&mut image, "1", 245, 25, 4);
    draw(&mut image, ":", 273, 25, 4);
    draw(&mut image, &last[..1], 285, 25, 4);
    draw(&mut image, &last[1..], 306, 25, 4);
    // A two-pixel compression bridge closes the one-pixel seconds gap.
    for x in 303..308 {
        image.data[34 * image.width + x] = 240;
    }
    if extra {
        draw(&mut image, "8", 327, 25, 4);
    }
    image
        .data
        .into_iter()
        .flat_map(|v| [v, v, v, 255])
        .collect()
}

#[test]
fn joined_seconds_are_proposed_and_split_only_with_confident_pixel_evidence() {
    let rgba = joined_seconds_frame("39", false);
    let recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let gray = discovery_gray(&rgba, 640, 360);
    let binary = threshold_gray(&gray, 180);
    let regions = clock_regions(&binary);
    assert_eq!(regions.len(), 1, "{regions:?}");
    let crop = crop_binary(&binary, &regions[0]);
    let segmented = segment_glyphs(&crop, &json!({"minGlyphWidth":1,"minInkRatio":0.02}));
    assert_eq!(segmented.boxes.len(), 3);
    let split = recognizer
        .split_seconds_pair(&crop, &crop, &segmented.boxes)
        .expect("a real low-ink valley and two confident glyphs");
    assert_eq!(split.len(), 4);
    let reading = recognizer
        .read_rect(&rgba, 640, 360, &regions[0], true)
        .expect("joined seconds are readable");
    assert_eq!(reading.text, "1:39");
    assert!(reading.scores.iter().all(|&score| score >= MIN_SCORE));
    assert_eq!(recognizer.discover(&rgba, 640, 360, false).len(), 1);
}

#[test]
fn a_wide_single_digit_and_a_third_seconds_digit_are_not_repaired_into_clocks() {
    let recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let mut image = Image {
        data: vec![12; 640 * 360],
        width: 640,
        height: 360,
    };
    draw(&mut image, "1:8", 245, 25, 4);
    let binary = threshold_gray(&image, 180);
    let rect = Rect {
        x: 240.0,
        y: 20.0,
        width: 90.0,
        height: 40.0,
    };
    let crop = crop_binary(&binary, &rect);
    let segmented = segment_glyphs(&crop, &json!({"minGlyphWidth":1,"minInkRatio":0.02}));
    assert_eq!(segmented.boxes.len(), 3);
    assert!(recognizer
        .split_seconds_pair(&crop, &crop, &segmented.boxes)
        .is_none());
    let rgba: Vec<_> = image
        .data
        .into_iter()
        .flat_map(|v| [v, v, v, 255])
        .collect();
    assert!(recognizer.discover(&rgba, 640, 360, false).is_empty());
    assert!(recognizer
        .discover(&joined_seconds_frame("39", true), 640, 360, false)
        .is_empty());
}

fn manual_roi() -> Value {
    json!({"x":0.375,"y":0.05,"w":0.175,"h":0.125})
}

#[test]
fn manual_region_stays_fixed_over_countdown_failures_reset_and_resizing() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let roi = manual_roi();
    recognizer.set_roi(&roi.to_string()).unwrap();
    let mut locked = false;
    for index in 0..60 {
        let time = index as f64 / 15.0;
        let seconds = 109 - time.floor() as usize;
        let rgba = frame(
            &format!("{}:{:02}", seconds / 60, seconds % 60),
            Some("0:29"),
        );
        let result = recognizer.push(
            &rgba,
            640,
            360,
            time,
            time * 1000.0,
            index as f64,
            index % 15 == 0,
        );
        assert_eq!(result["basic"]["mode"], "manual");
        assert_eq!(result["basic"]["roi"], roi);
        locked |= result["outcome"]["status"] == "success";
    }
    assert!(
        locked,
        "an unrelated competing clock must not override an explicitly selected ROI"
    );
    let mut blank = Image {
        data: vec![12; 640 * 360],
        width: 640,
        height: 360,
    };
    draw(&mut blank, "0:29", 245, 225, 4);
    let rgba: Vec<_> = blank
        .data
        .into_iter()
        .flat_map(|value| [value, value, value, 255])
        .collect();
    for index in 60..90 {
        let time = index as f64 / 15.0;
        let result = recognizer.push(&rgba, 640, 360, time, time * 1000.0, index as f64, true);
        assert_ne!(result["outcome"]["status"], "success");
        assert_eq!(result["basic"]["roi"], roi);
        assert_eq!(result["basic"]["candidates"], json!([]));
        assert_eq!(
            result["debug"]["roiPixels"],
            json!({"x":240.0,"y":18.0,"width":112.0,"height":45.0})
        );
    }
    recognizer.reset();
    let mut large = Image {
        data: vec![12; 1280 * 720],
        width: 1280,
        height: 720,
    };
    draw(&mut large, "1:49", 490, 50, 8);
    let rgba: Vec<_> = large
        .data
        .into_iter()
        .flat_map(|value| [value, value, value, 255])
        .collect();
    let resized = recognizer.push(&rgba, 1280, 720, 0.0, 0.0, 1.0, true);
    assert_eq!(resized["basic"]["mode"], "manual");
    assert_eq!(resized["basic"]["roi"], roi);
    assert_eq!(
        resized["debug"]["roiPixels"],
        json!({"x":480.0,"y":36.0,"width":224.0,"height":90.0})
    );
    assert_eq!(resized["basic"]["status"], "confirming");
}

#[test]
fn invalid_region_does_not_change_selection_and_only_null_restores_auto() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let roi = manual_roi();
    recognizer.set_roi(&roi.to_string()).unwrap();
    for invalid in [
        "{}",
        "[]",
        "true",
        "{\"x\":NaN}",
        "{\"x\":0,\"y\":0,\"w\":0,\"h\":1}",
        "{\"x\":-0.1,\"y\":0,\"w\":0.2,\"h\":0.2}",
        "{\"x\":0.9,\"y\":0,\"w\":0.2,\"h\":0.2}",
        "{\"x\":0,\"y\":0.8,\"w\":0.2,\"h\":0.3}",
        "{\"x\":0,\"y\":0,\"w\":1e400,\"h\":1}",
    ] {
        assert!(recognizer.set_roi(invalid).is_err(), "{invalid}");
        assert_eq!(json!(recognizer.manual_roi), roi);
    }
    let rgba = frame("1:49", Some("0:29"));
    let manual = recognizer.push(&rgba, 640, 360, 0.0, 0.0, 1.0, true);
    assert_eq!(manual["basic"]["status"], "confirming");
    recognizer.set_roi("null").unwrap();
    let auto = recognizer.push(&rgba, 640, 360, 0.1, 100.0, 2.0, true);
    assert_eq!(auto["basic"]["mode"], "auto");
    assert_eq!(auto["basic"]["status"], "ambiguous");
    assert!(auto["basic"]["candidates"].as_array().unwrap().len() >= 2);
}

#[test]
fn failed_manual_diagnostics_show_real_binary_and_best_matches_without_acceptance() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    recognizer.set_roi(&manual_roi().to_string()).unwrap();
    let rgba = frame("9:49", None);
    let result = recognizer.push(&rgba, 640, 360, 0.0, 0.0, 1.0, true);
    assert_eq!(result["outcome"]["status"], "failed");
    assert_eq!(result["outcome"]["reason"], "invalid-format");
    assert!(result["outcome"].get("reading").is_none());
    assert!(result["debug"]["binary"]["data"]
        .as_array()
        .unwrap()
        .iter()
        .any(|pixel| pixel == 255));
    assert_eq!(result["debug"]["boxes"].as_array().unwrap().len(), 4);
    assert_eq!(result["debug"]["matches"].as_array().unwrap().len(), 4);
    assert_eq!(result["debug"]["matches"][0]["char"], "9");
    assert!(result["basic"]["threshold"].as_u64().is_some());
    let preview = &result["basic"]["preview"];
    assert_eq!(preview["width"], 320);
    assert_eq!(preview["height"], 180);
    assert_eq!(preview["data"].as_array().unwrap().len(), 320 * 180);
    let ordinary = recognizer.push(&rgba, 640, 360, 0.1, 100.0, 2.0, false);
    assert!(ordinary["debug"].is_null());
    assert!(ordinary["basic"].get("preview").is_none());

    let mut damaged = frame("1:49", None);
    for y in 25..53 {
        for x in 313..333 {
            let index = (y * 640 + x) * 4;
            damaged[index..index + 3].fill(240);
        }
    }
    let low = recognizer.push(&damaged, 640, 360, 0.2, 200.0, 3.0, true);
    assert_eq!(low["outcome"]["status"], "failed");
    assert_eq!(low["outcome"]["reason"], "low-confidence");
    assert_eq!(low["debug"]["matches"].as_array().unwrap().len(), 4);
    assert!(low["debug"]["matches"][3]["score"].as_f64().unwrap() < MIN_SCORE);
    assert!(low["outcome"].get("reading").is_none());
}

#[test]
fn searching_diagnostics_report_actual_failed_candidates_and_blank_preview() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let rgba = frame("9:49", None);
    let failed = recognizer.push(&rgba, 640, 360, 0.0, 0.0, 1.0, true);
    assert_ne!(failed["outcome"]["status"], "success");
    assert!(!failed["basic"]["candidates"].as_array().unwrap().is_empty());
    assert!(failed["debug"]["binary"]["data"].as_array().is_some());
    recognizer.reset();
    let blank = recognizer.push(&vec![0; 640 * 360 * 4], 640, 360, 0.0, 0.0, 1.0, true);
    assert_eq!(blank["basic"]["candidates"], json!([]));
    assert_eq!(blank["basic"]["preview"]["width"], 320);
    assert!(blank["debug"].is_null());
}

#[test]
fn search_region_excludes_competing_clocks_and_keeps_full_frame_coordinates() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let search = json!({"x":0.35,"y":0.55,"w":0.25,"h":0.20});
    recognizer.set_search_roi(&search.to_string()).unwrap();
    let rgba = frame("1:49", Some("0:29"));
    let selected = recognizer.push(&rgba, 640, 360, 0.0, 0.0, 1.0, true);
    assert_eq!(selected["basic"]["mode"], "auto");
    assert_eq!(selected["basic"]["status"], "confirming", "{selected}");
    assert_eq!(selected["basic"]["text"], "0:29");
    assert_eq!(selected["basic"]["searchRoi"], search);
    assert!(selected["debug"]["roiPixels"]["y"].as_f64().unwrap() >= 198.0);
    assert_eq!(selected["basic"]["preview"]["width"], 320);
    for roi in selected["basic"]["candidates"].as_array().unwrap() {
        assert!(roi["y"].as_f64().unwrap() >= 0.55);
        assert!(roi["y"].as_f64().unwrap() + roi["h"].as_f64().unwrap() <= 0.75);
    }
    recognizer.set_roi(&manual_roi().to_string()).unwrap();
    let manual = recognizer.push(&rgba, 640, 360, 0.1, 100.0, 2.0, true);
    assert_eq!(manual["basic"]["text"], "1:49");
    assert_eq!(manual["basic"]["roi"], manual_roi());
    assert_eq!(manual["basic"]["searchRoi"], search);
    recognizer.reset();
    assert_eq!(json!(recognizer.manual_roi), manual_roi());
    assert_eq!(json!(recognizer.search_roi), search);
    recognizer.set_roi("null").unwrap();
    recognizer.set_search_roi("null").unwrap();
    let both = recognizer.push(&rgba, 640, 360, 0.2, 200.0, 3.0, false);
    assert_eq!(both["basic"]["status"], "ambiguous");
}

#[test]
fn search_edges_never_expand_padding_outside_the_user_region() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    let search = json!({"x":249.0/640.0,"y":25.0/360.0,"w":84.0/640.0,"h":28.0/360.0});
    recognizer.set_search_roi(&search.to_string()).unwrap();
    let rgba = frame("1:49", None);
    let result = recognizer.push(&rgba, 640, 360, 0.0, 0.0, 1.0, true);
    assert_eq!(result["basic"]["status"], "confirming", "{result}");
    let roi = &result["debug"]["roiPixels"];
    assert!(roi["x"].as_f64().unwrap() >= 249.0);
    assert!(roi["y"].as_f64().unwrap() >= 25.0);
    assert!(roi["x"].as_f64().unwrap() + roi["width"].as_f64().unwrap() <= 333.0);
    assert!(roi["y"].as_f64().unwrap() + roi["height"].as_f64().unwrap() <= 53.0);
    let selected = json!(recognizer.search_roi);
    for invalid in [
        "{}",
        "true",
        "{\"x\":0,\"y\":0,\"w\":0,\"h\":1}",
        "{\"x\":0.9,\"y\":0,\"w\":0.2,\"h\":0.2}",
        "{\"x\":0,\"y\":0,\"w\":1e400,\"h\":1}",
    ] {
        assert!(recognizer.set_search_roi(invalid).is_err());
        assert_eq!(json!(recognizer.search_roi), selected);
    }
    recognizer
        .set_search_roi("{\"x\":0.9,\"y\":0.9,\"w\":0.000001,\"h\":0.000001}")
        .unwrap();
    for (width, height) in [(1, 1), (2, 3), (640, 360)] {
        let result = recognizer.push(
            &vec![0; width * height * 4],
            width,
            height,
            0.0,
            0.0,
            1.0,
            true,
        );
        assert_eq!(result["basic"]["candidates"], json!([]));
        assert_ne!(result["outcome"]["status"], "success");
    }
}

#[test]
fn loose_manual_regions_keep_real_ticks_with_duplicate_frames_and_debug_toggling() {
    for scale in [4, 8] {
        let width = 160 * scale;
        let height = 90 * scale;
        let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
        let manual = json!({"x":0.0,"y":0.0,"w":1.0,"h":0.75});
        recognizer.set_roi(&manual.to_string()).unwrap();
        let mut ticks = Vec::new();
        let mut successes = 0;
        for index in 0..76 {
            let time = index as f64 / 15.0;
            let value = 109 - time.floor() as usize;
            let mut image = Image {
                data: vec![12; width * height],
                width,
                height,
            };
            draw(
                &mut image,
                &format!("{}:{:02}", value / 60, value % 60),
                60 * scale,
                20 * scale,
                scale,
            );
            let rgba: Vec<_> = image
                .data
                .into_iter()
                .flat_map(|v| [v, v, v, 255])
                .collect();
            let result = recognizer.push(
                &rgba,
                width,
                height,
                time,
                time * 1000.0,
                index as f64,
                index % 8 == 0,
            );
            assert_eq!(result["basic"]["roi"], manual);
            if result["outcome"]["status"] == "success" {
                successes += 1;
            }
            if let Some(tick) = result.get("tickMoment") {
                ticks.push(tick.clone());
            }
            if index % 3 == 0 {
                let duplicate = recognizer.push(
                    &rgba,
                    width,
                    height,
                    time,
                    time * 1000.0,
                    (index + 1000) as f64,
                    true,
                );
                assert_ne!(duplicate["outcome"]["status"], "success");
                assert_eq!(
                    duplicate["outcome"]["reason"],
                    "basic-clock-duplicate-frame"
                );
            }
        }
        assert!(successes > 20, "scale={scale}, successes={successes}");
        assert!(ticks.len() >= 2, "scale={scale}, ticks={ticks:?}");
        for tick in ticks {
            let left = tick["lastUnchanged"].as_f64().unwrap();
            let right = tick["firstChanged"].as_f64().unwrap();
            assert!(left < right && right - left <= 0.1);
        }
    }
}

#[test]
fn duplicate_frames_cannot_manufacture_stable_decrements() {
    let mut recognizer = BasicClockRecognizer::new(&templates()).unwrap();
    recognizer.set_roi(&manual_roi().to_string()).unwrap();
    for second in 0..5 {
        let value = 109 - second;
        for repeat in 0..10 {
            let result = push(
                &mut recognizer,
                &format!("{}:{:02}", value / 60, value % 60),
                second as f64,
            );
            assert_ne!(
                result["outcome"]["status"], "success",
                "second={second}, repeat={repeat}"
            );
        }
    }
}

fn generic_priors() -> BTreeMap<String, Vec<String>> {
    serde_json::from_str(include_str!(
        "../../../src/recognition/basicGlyphPriors.json"
    ))
    .unwrap()
}

fn rasterized_prior(mask: &[u8], glyph_height: usize, phase: f64, noise: usize) -> Image {
    let width = (32.0 * glyph_height as f64 / 48.0).ceil() as usize + 8;
    let height = glyph_height + 8;
    let mut data = vec![12; width * height];
    let scale = glyph_height as f64 / 48.0;
    for y in 0..height {
        for x in 0..width {
            let x0 = ((x as f64 - 4.0 - phase) / scale).clamp(0.0, 32.0);
            let x1 = ((x as f64 + 1.0 - 4.0 - phase) / scale).clamp(0.0, 32.0);
            let y0 = ((y as f64 - 4.0 - phase * 0.7) / scale).clamp(0.0, 48.0);
            let y1 = ((y as f64 + 1.0 - 4.0 - phase * 0.7) / scale).clamp(0.0, 48.0);
            let mut coverage = 0.0;
            for yy in y0.floor() as usize..y1.ceil() as usize {
                for xx in x0.floor() as usize..x1.ceil() as usize {
                    let area = (x1.min(xx as f64 + 1.0) - x0.max(xx as f64)).max(0.0)
                        * (y1.min(yy as f64 + 1.0) - y0.max(yy as f64)).max(0.0);
                    if mask[yy * 32 + xx] != 0 {
                        coverage += area * scale * scale;
                    }
                }
            }
            let jitter = if noise == 0 {
                0.0
            } else {
                ((x * 11 + y * 17 + noise * 13) % 9) as f64 - 4.0
            };
            data[y * width + x] =
                (12.0 + 228.0 * coverage + jitter).clamp(0.0, 255.0).round() as u8;
        }
    }
    Image {
        data,
        width,
        height,
    }
}

fn transformed_decision(recognizer: &BasicClockRecognizer, gray: &Image) -> (String, f64, f64) {
    transformed_decision_variant(recognizer, gray, false)
}
fn transformed_decision_variant(
    recognizer: &BasicClockRecognizer,
    gray: &Image,
    improved: bool,
) -> (String, f64, f64) {
    let mut best = (String::new(), 0.0, 0.0);
    for threshold in [180, 135, 215] {
        let binary = threshold_gray(gray, threshold);
        if improved
            && bounding_box(&binary).is_some_and(|bounds| bounds.width > bounds.height * 0.95)
        {
            continue;
        }
        let normalized = normalize_glyph(&binary);
        let (char, score, runner) = if improved {
            recognizer.match_glyph(&normalized, gray)
        } else {
            recognizer.match_mask_nominal(&normalized)
        };
        if score >= MIN_SCORE && score - runner >= MIN_MARGIN && score > best.1 {
            best = (char.to_owned(), score, runner);
        }
    }
    best
}
fn negative_glyph_cases(priors: &BTreeMap<String, Vec<String>>) -> Vec<(String, Image)> {
    let mut cases = vec![
        (
            "blank".into(),
            Image {
                data: vec![12; 20 * 28],
                width: 20,
                height: 28,
            },
        ),
        (
            "solid".into(),
            Image {
                data: vec![240; 20 * 28],
                width: 20,
                height: 28,
            },
        ),
    ];
    for kind in 0..3 {
        let mut mask = vec![0; 1536];
        for y in 0..48 {
            for x in 0..32 {
                let ink = match kind {
                    0 => {
                        (x as i32 - y as i32 * 2 / 3).abs() < 3
                            || (31 - x as i32 - y as i32 * 2 / 3).abs() < 3
                    }
                    1 => (x / 4 + y / 4) % 2 == 0,
                    _ => x % 7 < 2 || y % 11 < 2,
                };
                if ink {
                    mask[y * 32 + x] = 255;
                }
            }
        }
        for height in [14, 18, 24, 32] {
            for phase in [0.0, 0.7] {
                cases.push((
                    format!("unknown-{kind}-{height}-{phase}"),
                    rasterized_prior(&mask, height, phase, 1),
                ));
            }
        }
    }
    for (char, samples) in priors {
        if char == ":" {
            continue;
        }
        for (sample_index, sample) in samples.iter().enumerate().step_by(4) {
            let original = unpack_bitmap(sample, 1536).unwrap();
            for half in [0, 1] {
                let mut mask = original.clone();
                for y in 0..48 {
                    for x in 0..32 {
                        if (y < 24) == (half == 0) {
                            mask[y * 32 + x] = 0;
                        }
                    }
                }
                for height in [18, 24] {
                    for phase in [0.0, 0.7] {
                        cases.push((
                            format!("half-{char}-{sample_index}-{half}-{height}-{phase}"),
                            rasterized_prior(&mask, height, phase, 1),
                        ));
                    }
                }
            }
        }
    }
    cases
}
fn clock_with_unit_image(priors: &BTreeMap<String, Vec<String>>, unit: &Image) -> Image {
    let glyph_height = unit.height.saturating_sub(8).max(14);
    let parts: Vec<_> = [
        ("0", glyph_height),
        (":", glyph_height * 2 / 3),
        ("2", glyph_height),
    ]
    .into_iter()
    .map(|(char, height)| {
        rasterized_prior(
            &unpack_bitmap(&priors[char][0], 1536).unwrap(),
            height,
            0.0,
            0,
        )
    })
    .collect();
    let width = parts.iter().map(|part| part.width + 4).sum::<usize>() + unit.width + 8;
    let height = glyph_height + 16;
    let mut data = vec![12; width * height];
    let mut x = 4;
    for part in parts.iter().chain(std::iter::once(unit)) {
        let y = (height - part.height) / 2;
        for yy in 0..part.height {
            for xx in 0..part.width {
                data[(y + yy) * width + x + xx] = part.data[yy * part.width + xx];
            }
        }
        x += part.width + 4;
    }
    Image {
        data,
        width,
        height,
    }
}
fn clock_decision(recognizer: &BasicClockRecognizer, gray: &Image, improved: bool) -> String {
    if improved {
        let rgba: Vec<_> = gray.data.iter().flat_map(|&v| [v, v, v, 255]).collect();
        return recognizer
            .read_rect(
                &rgba,
                gray.width,
                gray.height,
                &Rect {
                    x: 0.0,
                    y: 0.0,
                    width: gray.width as f64,
                    height: gray.height as f64,
                },
                false,
            )
            .map(|reading| reading.text)
            .unwrap_or_default();
    }
    let mut best = (String::new(), 0.0);
    for threshold in [180, 135, 215] {
        let binary = threshold_gray(gray, threshold);
        let segmented = segment_glyphs(&binary, &json!({"minGlyphWidth":1,"minInkRatio":0.02}));
        if segmented.boxes.len() != 4 {
            continue;
        }
        let mut text = String::new();
        let mut score = 1.0_f64;
        let mut valid = true;
        for glyph in segmented.boxes {
            let mask = normalize_glyph(&crop_binary(&binary, &glyph.rect()));
            let matched = recognizer.match_mask_nominal(&mask);
            valid &= matched.1 >= MIN_SCORE && matched.1 - matched.2 >= MIN_MARGIN;
            text.push_str(matched.0);
            score = score.min(matched.1);
        }
        if valid && crate::parse_countdown(&text, "m:ss").is_some() && score > best.1 {
            best = (text, score);
        }
    }
    best.0
}

#[test]
#[ignore = "controlled generic-prior rasterization experiment, run release with nocapture"]
fn benchmark_generic_glyph_transform_sensitivity() {
    let priors = generic_priors();
    let recognizer = BasicClockRecognizer::new(&serde_json::to_string(&priors).unwrap()).unwrap();
    let mut counts = [(0, 0, 0); 2];
    let mut failures = Vec::new();
    let started = std::time::Instant::now();
    for (symbol, samples) in &priors {
        if symbol == ":" {
            continue;
        }
        for sample in samples {
            let mask = unpack_bitmap(sample, 1536).unwrap();
            for height in [14, 18, 24, 32] {
                for phase in [0.0, 0.35, 0.70] {
                    for noise in [0, 1] {
                        let gray = rasterized_prior(&mask, height, phase, noise);
                        for (variant, improved) in [false, true].into_iter().enumerate() {
                            let read = transformed_decision_variant(&recognizer, &gray, improved).0;
                            if read == *symbol {
                                counts[variant].0 += 1;
                            } else if read.is_empty() {
                                counts[variant].1 += 1;
                            } else {
                                counts[variant].2 += 1;
                                failures.push((symbol.clone(), read, height, phase, noise));
                            }
                        }
                    }
                }
            }
        }
    }
    println!("generic positives (correct/rejected/wrong): baseline={:?}, production={:?}, elapsed_ms={:.1}, wrong={failures:?}",
        counts[0], counts[1], started.elapsed().as_secs_f64() * 1000.0);
    let negatives = negative_glyph_cases(&priors);
    let mut accepted = [Vec::new(), Vec::new()];
    for (name, glyph) in &negatives {
        let word = clock_with_unit_image(&priors, glyph);
        for (variant, improved) in [false, true].into_iter().enumerate() {
            let read = clock_decision(&recognizer, &word, improved);
            if !read.is_empty() {
                accepted[variant].push((name, read));
            }
        }
    }
    println!(
        "negative full clocks: cases={}, baseline_accepts={}, production_accepts={:?}",
        negatives.len(),
        accepted[0].len(),
        accepted[1]
    );
    assert_eq!(counts[0].2, 0);
    assert_eq!(counts[1].2, 0);
    assert!(counts[1].0 > counts[0].0);
    assert!(accepted[1].is_empty());
}

#[test]
#[ignore = "manual comparison on explicitly authorized, frozen clock crops"]
fn benchmark_frozen_real_clock_matching() {
    let dir = std::env::var("BASIC_CLOCK_RIO_TEST_DIR")
        .expect("provide an authorized frozen crop directory");
    let templates = std::fs::read_to_string(format!("{dir}/templates.json")).unwrap();
    let recognizer = BasicClockRecognizer::new(&templates).unwrap();
    for (name, width, height) in [("native", 88, 44), ("1920", 66, 33)] {
        let bytes = std::fs::read(format!("{dir}/rio-clock-{name}.rgba")).unwrap();
        assert_eq!(bytes.len(), width * height * 4 * 36);
        let mut counts = [(0, 0, 0); 2];
        let mut rejected = Vec::new();
        let mut milliseconds = Vec::new();
        for (index, rgba) in bytes.chunks_exact(width * height * 4).enumerate() {
            let rect = Rect {
                x: 0.0,
                y: 0.0,
                width: width as f64,
                height: height as f64,
            };
            let gray = native_gray(rgba, width, &rect);
            let truth = format!("0:{:02}", 37 - index);
            for (variant, improved) in [false, true].into_iter().enumerate() {
                let start = std::time::Instant::now();
                let text = clock_decision(&recognizer, &gray, improved);
                if improved {
                    milliseconds.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                if text == truth {
                    counts[variant].0 += 1;
                } else if text.is_empty() {
                    counts[variant].1 += 1;
                    if improved {
                        rejected.push(truth.clone());
                    }
                } else {
                    counts[variant].2 += 1;
                    eprintln!("{name}: expected={truth}, actual={text}");
                }
            }
        }
        milliseconds.sort_by(f64::total_cmp);
        println!("frozen {name} (correct/rejected/wrong): baseline={:?}, production={:?}, rejected={rejected:?}, p50_ms={:.3}, p95_ms={:.3}",
            counts[0], counts[1], milliseconds[18], milliseconds[34]);
        assert!(counts[1].0 > counts[0].0);
        assert_eq!(counts[1].2, 0);
    }
    let runtime: Value = serde_json::from_str(
        &std::fs::read_to_string(format!("{dir}/runtime-frames.json")).unwrap(),
    )
    .unwrap();
    let frames = runtime
        .as_array()
        .expect("an array of manually labeled Worker inputs");
    assert_eq!(frames.len(), 26);
    let mut counts = [(0, 0, 0); 2];
    let mut rejected = Vec::new();
    for frame in frames {
        let width = frame["width"].as_u64().unwrap() as usize;
        let height = frame["height"].as_u64().unwrap() as usize;
        let rgba: Vec<_> = frame["pixels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pixel| pixel.as_u64().unwrap() as u8)
            .collect();
        assert_eq!(rgba.len(), width * height * 4);
        let gray = native_gray(
            &rgba,
            width,
            &Rect {
                x: 0.0,
                y: 0.0,
                width: width as f64,
                height: height as f64,
            },
        );
        let truth = frame["truth"].as_str().unwrap();
        for (variant, improved) in [false, true].into_iter().enumerate() {
            let text = clock_decision(&recognizer, &gray, improved);
            if text == truth {
                counts[variant].0 += 1;
            } else if text.is_empty() {
                counts[variant].1 += 1;
                if improved {
                    rejected.push((truth, frame["role"].clone()));
                }
            } else {
                counts[variant].2 += 1;
                eprintln!("runtime: expected={truth}, actual={text}");
            }
        }
    }
    println!("Worker runtime frames (correct/rejected/wrong): baseline={:?}, production={:?}, rejected={rejected:?}", counts[0], counts[1]);
    assert!(counts[1].0 > counts[0].0);
    assert_eq!(counts[1].2, 0);
}

#[test]
fn generic_pixel_grid_changes_improve_without_confusing_similar_digits() {
    let priors = generic_priors();
    let recognizer = BasicClockRecognizer::new(&serde_json::to_string(&priors).unwrap()).unwrap();
    let (mut baseline_correct, mut improved_correct) = (0, 0);
    for char in ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] {
        for sample in priors[char].iter().step_by(4) {
            let mask = unpack_bitmap(sample, 1536).unwrap();
            for height in [14, 18] {
                for phase in [0.35, 0.70] {
                    let image = rasterized_prior(&mask, height, phase, 1);
                    let baseline = transformed_decision(&recognizer, &image);
                    let refined = transformed_decision_variant(&recognizer, &image, true);
                    baseline_correct += usize::from(baseline.0 == char);
                    improved_correct += usize::from(refined.0 == char);
                    assert!(
                        refined.0.is_empty() || refined.0 == char,
                        "truth={char},read={:?},height={height},phase={phase}",
                        refined
                    );
                }
            }
        }
    }
    assert!(
        improved_correct > baseline_correct,
        "baseline={baseline_correct},refined={improved_correct}"
    );
}

#[test]
fn partial_unknown_blank_and_solid_glyphs_do_not_become_clock_values() {
    let priors = generic_priors();
    let recognizer = BasicClockRecognizer::new(&serde_json::to_string(&priors).unwrap()).unwrap();
    let negatives = negative_glyph_cases(&priors);
    for (index, (name, glyph)) in negatives.iter().enumerate() {
        if index % 4 != 0 && !matches!(name.as_str(), "blank" | "solid") {
            continue;
        }
        let word = clock_with_unit_image(&priors, glyph);
        assert!(
            clock_decision(&recognizer, &word, true).is_empty(),
            "negative={name}"
        );
    }
}

#[test]
fn topology_and_one_pixel_support_do_not_bridge_missing_digit_structure() {
    let priors = generic_priors();
    let shape = |char: &str| PackedMask::new(&unpack_bitmap(&priors[char][0], 1536).unwrap());
    assert_eq!(shape("0").holes, 1);
    assert_eq!(shape("8").holes, 2);
    assert_eq!(shape("1").holes, 0);
    assert_eq!(shape("7").holes, 0);
    let mut left = vec![0; 1536];
    let mut right = vec![0; 1536];
    for y in 0..48 {
        for x in 12..16 {
            left[y * 32 + x] = 255;
            right[y * 32 + x + 3] = 255;
        }
    }
    assert!(PackedMask::new(&left).boundary_score(&PackedMask::new(&right)) < MIN_SCORE);
}

#[test]
fn native_topology_survives_normalization_changes_in_low_resolution_glyphs() {
    let priors = generic_priors();
    let recognizer = BasicClockRecognizer::new(&serde_json::to_string(&priors).unwrap()).unwrap();
    let mut recovered = 0;
    for symbol in ["6", "8", "9"] {
        for sample in &priors[symbol] {
            let mask = unpack_bitmap(sample, 1536).unwrap();
            for height in [14, 18] {
                for phase in [0.0, 0.35, 0.70] {
                    let gray = rasterized_prior(&mask, height, phase, 1);
                    let mut changed = false;
                    for threshold in [135, 180, 215] {
                        let binary = threshold_gray(&gray, threshold);
                        let source = source_topology(&binary);
                        let normalized = PackedMask::new(&normalize_glyph(&binary));
                        changed |= source.0 != normalized.holes;
                    }
                    let read = transformed_decision_variant(&recognizer, &gray, true).0;
                    assert!(
                        read.is_empty() || read == symbol,
                        "expected={symbol}, actual={read}, height={height}, phase={phase}"
                    );
                    recovered += usize::from(changed && read == symbol);
                }
            }
        }
    }
    assert!(
        recovered > 0,
        "the corpus must include actual topology changes caused by normalization"
    );
}

#[test]
fn closed_outline_priors_cannot_rename_six_or_nine() {
    let priors = generic_priors();
    let mut polluted = priors.clone();
    // Model an outline transform that closes the open arc of 5 or 3. These
    // samples remain unfit for those labels even when their pixel IoU is high.
    for (confuser, truth) in [("5", "6"), ("3", "9")] {
        polluted
            .get_mut(confuser)
            .unwrap()
            .push(priors[truth][0].clone());
    }
    let recognizer = BasicClockRecognizer::new(&serde_json::to_string(&polluted).unwrap()).unwrap();
    for symbol in ["6", "9"] {
        let mask = unpack_bitmap(&priors[symbol][0], 1536).unwrap();
        let gray = rasterized_prior(&mask, 24, 0.35, 1);
        assert!(transformed_decision(&recognizer, &gray).0.is_empty());
        assert_eq!(
            transformed_decision_variant(&recognizer, &gray, true).0,
            symbol
        );
        let word = clock_with_unit_image(&priors, &gray);
        assert_eq!(
            clock_decision(&recognizer, &word, true),
            format!("0:2{symbol}")
        );
    }
    let six = PackedMask::new(&unpack_bitmap(&priors["6"][0], 1536).unwrap());
    let nine = PackedMask::new(&unpack_bitmap(&priors["9"][0], 1536).unwrap());
    assert!(!six.same_source_topology(&(nine.holes, nine.hole_y)));
}

#[test]
fn slashed_zero_keeps_shape_competition_and_native_topology() {
    // A diagonal stroke splits the counter of zero into two enclosed regions.
    // The Worker fixture uses this legitimate zero at different pixel scales.
    let rows = [
        "01110", "10001", "10011", "10101", "11001", "10001", "01110",
    ];
    let render = |scale: usize| {
        let mut image = Image {
            data: vec![0; 5 * 7 * scale * scale],
            width: 5 * scale,
            height: 7 * scale,
        };
        for (y, row) in rows.iter().enumerate() {
            for (x, pixel) in row.bytes().enumerate() {
                if pixel == b'1' {
                    for yy in 0..scale {
                        for xx in 0..scale {
                            image.data[(y * scale + yy) * image.width + x * scale + xx] = 255;
                        }
                    }
                }
            }
        }
        image
    };
    let sample = normalize_glyph(&render(6));
    assert_eq!(PackedMask::new(&sample).holes, 2);
    let mut priors: BTreeMap<String, Vec<String>> = serde_json::from_str(&templates()).unwrap();
    priors.get_mut("0").unwrap().push(pack_bitmap(&sample));
    let recognizer = BasicClockRecognizer::new(&serde_json::to_string(&priors).unwrap()).unwrap();
    for scale in [2, 3, 6] {
        let image = render(scale);
        assert_eq!(source_topology(&image).0, 2);
        let (symbol, score, runner) = recognizer.match_glyph(&normalize_glyph(&image), &image);
        assert_eq!(symbol, "0", "scale={scale}, score={score}, runner={runner}");
        assert!(score >= MIN_SCORE && score - runner >= MIN_MARGIN);
    }
    let eight = glyph(8, 3);
    assert_eq!(
        recognizer.match_glyph(&normalize_glyph(&eight), &eight).0,
        "8"
    );
}
