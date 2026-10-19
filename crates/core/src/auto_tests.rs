use super::*;

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

fn render(image: &mut Image, x: usize, y: usize, value: usize, scale: usize) {
    let symbols = [value / 60, 10, value % 60 / 10, value % 10];
    let mut left = x;
    for symbol in symbols {
        let font = FONT[symbol];
        for (dy, row) in font.iter().enumerate() {
            for (dx, pixel) in row.bytes().enumerate() {
                if pixel == b'0' {
                    continue;
                }
                for yy in 0..scale {
                    for xx in 0..scale {
                        let px = left + dx * scale + xx;
                        let py = y + dy * scale + yy;
                        if px < image.width && py < image.height {
                            image.data[py * image.width + px] = 240;
                        }
                    }
                }
            }
        }
        left += (font[0].len() + 2) * scale;
    }
}

fn frame(w: usize, h: usize, index: usize, time: f64, clock: bool, distractors: bool) -> Image {
    let mut image = Image {
        data: vec![12; w * h],
        width: w,
        height: h,
    };
    let scale = (h / 180).max(1);
    // Deliberately below and left of centre, with no scoreboard-position prior.
    if clock {
        render(
            &mut image,
            w / 7,
            h * 2 / 3,
            89usize.saturating_sub(time.floor() as usize),
            scale,
        );
    }
    if distractors {
        if time < 5.0 {
            render(
                &mut image,
                w * 2 / 3,
                h / 6,
                99 - (time + 0.37).floor() as usize,
                scale,
            );
        }
        let camera_w = w / 5;
        let camera_h = h / 5;
        for yy in h / 8..h / 8 + camera_h {
            for xx in w / 8..w / 8 + camera_w {
                image.data[yy * w + xx] = ((xx * 19 + yy * 31 + index * 73) % 256) as u8;
            }
        }
        let moving_x = (index * 17) % (w - w / 12);
        for yy in h / 2..h / 2 + h / 30 {
            for xx in moving_x..moving_x + w / 12 {
                image.data[yy * w + xx] = 220;
            }
        }
    }
    for (i, pixel) in image.data.iter_mut().enumerate() {
        let noise = ((i * 7 + index * 17) % 7) as i16 - 3;
        *pixel = (*pixel as i16 + noise).clamp(0, 255) as u8;
    }
    image
}

#[test]
fn tick_moment_brackets_truth_at_5994_with_encoder_noise() {
    let mut detector = TickMomentDetector::new();
    let mut ticks = vec![];
    for n in 0..240 {
        let time = n as f64 * 1001.0 / 60000.0;
        let mut image = Image {
            data: vec![10; 90 * 25],
            width: 90,
            height: 25,
        };
        render(&mut image, 2, 3, 89 - time.floor() as usize, 2);
        for (i, p) in image.data.iter_mut().enumerate() {
            *p = p.saturating_add(((n * 13 + i * 7) % 5) as u8);
        }
        if let Some(tick) = detector.push(&image, time) {
            ticks.push(tick);
        }
    }
    assert_eq!(ticks.len(), 3);
    for (i, tick) in ticks.iter().enumerate() {
        let truth = (i + 1) as f64;
        assert!(tick.last_unchanged < truth && tick.first_changed >= truth);
        assert!((tick.tick_time - truth).abs() <= 1001.0 / 60000.0);
    }
    detector.reset();
    assert!(detector
        .push(
            &Image {
                data: vec![0; 4],
                width: 2,
                height: 2
            },
            0.0
        )
        .is_none());
}

#[test]
fn localises_anywhere_and_rejects_camera_motion_and_disappearing_replay() {
    let frames: Vec<_> = (0..110)
        .map(|n| {
            let time = n as f64 * 0.1001;
            TimedFrame {
                time,
                image: frame(480, 270, n, time, true, true),
            }
        })
        .collect();
    let candidates = locate_clock(&frames);
    assert!(!candidates.is_empty(), "no candidates");
    let top = &candidates[0];
    assert!((top.roi.x - 1.0 / 7.0).abs() < 0.02, "{:?}", top);
    assert!((top.roi.y - 2.0 / 3.0).abs() < 0.03);
    assert!(top.persistence > 0.95);
    assert!((top.period - 1.0).abs() < 0.03);
    assert!(candidates.iter().all(|c| c.roi.y > 0.5));
}

#[test]
fn full_resolution_1080_and_1440_scan_has_no_position_assumption() {
    for (w, h) in [(1920, 1080), (2560, 1440)] {
        let frames: Vec<_> = (0..13)
            .map(|n| {
                let time = n as f64 * 0.5;
                TimedFrame {
                    time,
                    image: frame(w, h, n, time, true, false),
                }
            })
            .collect();
        let candidates = locate_clock(&frames);
        assert!(!candidates.is_empty(), "{w}x{h}");
        assert!((candidates[0].roi.x - 1.0 / 7.0).abs() < 0.01);
    }
}

#[test]
fn self_learning_recovers_exact_labels_and_valid_v2_profile() {
    let frames: Vec<_> = (0..320)
        .map(|n| {
            let time = n as f64 * 0.1001;
            TimedFrame {
                time,
                image: frame(480, 270, n, time, true, false),
            }
        })
        .collect();
    let roi = RoiRect {
        x: 65.0 / 480.0,
        y: 177.0 / 270.0,
        w: 29.0 / 480.0,
        h: 13.0 / 270.0,
    };
    let report = learn_clock(&frames, &roi);
    assert!(report.reason.is_none(), "{:?}", report);
    assert_eq!(report.consistent_offsets, 1);
    let profile = report.profile.unwrap();
    assert!(validate_profile(&serde_json::to_value(&profile).unwrap())["profile"].is_object());
    assert_eq!(report.learned_chars.len(), 11);
    for n in 0..30 {
        let time = n as f64 + 0.2;
        let result = recognize_auto_frame(&frame(480, 270, n, time, true, false), &profile);
        assert_eq!(result.value, Some((89 - n) as f64), "{:?}", result);
    }
}

#[test]
fn short_ambiguous_learning_never_guesses_labels() {
    let frames: Vec<_> = (0..70)
        .map(|n| {
            let time = n as f64 * 0.1001;
            TimedFrame {
                time,
                image: frame(480, 270, n, time, true, false),
            }
        })
        .collect();
    let roi = RoiRect {
        x: 65.0 / 480.0,
        y: 177.0 / 270.0,
        w: 29.0 / 480.0,
        h: 13.0 / 270.0,
    };
    let report = learn_clock(&frames, &roi);
    assert_eq!(report.reason.as_deref(), Some("ambiguous-countdown-labels"));
    assert!(report.consistent_offsets > 1);
    assert!(report.missing_chars.len() > 1);
}

#[test]
fn frozen_absent_and_invalid_frames_are_rejected() {
    let still = frame(240, 135, 0, 0.0, true, false);
    let frozen: Vec<_> = (0..50)
        .map(|n| TimedFrame {
            time: n as f64 * 0.1,
            image: still.clone(),
        })
        .collect();
    assert!(locate_clock(&frozen).is_empty());
    let absent: Vec<_> = (0..50)
        .map(|n| TimedFrame {
            time: n as f64 * 0.1,
            image: frame(240, 135, n, 6.0 + n as f64 * 0.1, false, true),
        })
        .collect();
    assert!(locate_clock(&absent).is_empty());
    let roi = RoiRect {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };
    assert!(learn_clock(&frozen, &roi).profile.is_none());
    assert!(locate_clock(&[TimedFrame {
        time: f64::NAN,
        image: still
    }])
    .is_empty());
}

#[test]
fn colon_dots_do_not_merge_with_unrelated_bright_fragment_above() {
    let mut image = frame(960, 540, 0, 0.0, true, false);
    let x = 960 / 7 + 7 * 3;
    for y in 340..343 {
        for xx in x..x + 3 {
            image.data[y * 960 + xx] = 240;
        }
    }
    let rects = proposals(&image, 190);
    assert!(
        rects
            .iter()
            .any(|r| r.x > 130.0 && r.x < 140.0 && r.y > 350.0 && r.y < 362.0),
        "{rects:?}"
    );
}

#[test]
fn noisy_soft_assignment_balances_constant_minutes_against_seconds_positions() {
    let mut observations = vec![];
    for n in 0..32 {
        let image = frame(480, 270, n, n as f64 + 0.2, true, false);
        let region = crop_binary(
            &image,
            &Rect {
                x: 65.0,
                y: 177.0,
                width: 29.0,
                height: 13.0,
            },
        );
        let mut masks: Vec<_> = glyphs(&region, 190.0)
            .unwrap()
            .iter()
            .map(normalize_glyph)
            .collect();
        for (position, mask) in masks.iter_mut().enumerate() {
            for i in 0..30 {
                let pixel = (i * 73 + n * 17 + position * 31) % 1536;
                mask[pixel] = 255 - mask[pixel];
            }
        }
        observations.push(Observation {
            time: n as f64,
            masks,
            clusters: vec![],
        });
    }
    let (labels, count, quality) = soft_assignments(&observations).unwrap();
    assert_eq!(count, 1);
    assert!(quality > 0.85);
    for n in 0..32 {
        assert_eq!(labels[n * 4..n * 4 + 4], expected_labels(89 - n).map(Some));
    }
}

#[test]
fn localisation_envelope_contains_variable_width_digits_for_learning() {
    let thin_font = [
        [
            "01110", "10001", "10011", "10101", "11001", "10001", "01110",
        ],
        [
            "00100", "01100", "00100", "00100", "00100", "00100", "01110",
        ],
        [
            "01110", "10001", "00001", "00010", "00100", "01000", "11111",
        ],
        [
            "11111", "00010", "00100", "00010", "00001", "10001", "01110",
        ],
        [
            "00010", "00110", "01010", "10010", "11111", "00010", "00010",
        ],
        [
            "11111", "10000", "11110", "00001", "00001", "10001", "01110",
        ],
        [
            "00110", "01000", "10000", "11110", "10001", "10001", "01110",
        ],
        [
            "11111", "00001", "00010", "00100", "01000", "01000", "01000",
        ],
        [
            "01110", "10001", "10001", "01110", "10001", "10001", "01110",
        ],
        [
            "01110", "10001", "10001", "01111", "00001", "00010", "01100",
        ],
        [
            "00000", "00100", "00100", "00000", "00100", "00100", "00000",
        ],
    ];
    let frames: Vec<_> = (0..144)
        .map(|n| {
            let value = 82 - n / 8;
            let mut image = Image {
                data: vec![12; 320 * 180],
                width: 320,
                height: 180,
            };
            for (p, symbol) in [value / 60, 10, value % 60 / 10, value % 10]
                .into_iter()
                .enumerate()
            {
                for (y, row) in thin_font[symbol].iter().enumerate() {
                    for (x, pixel) in row.bytes().enumerate() {
                        if pixel == b'1' {
                            for dy in 0..2 {
                                for dx in 0..2 {
                                    image.data
                                        [(103 + y * 2 + dy) * 320 + 74 + p * 12 + x * 2 + dx] = 235;
                                }
                            }
                        }
                    }
                }
            }
            TimedFrame {
                time: n as f64 / 8.0,
                image,
            }
        })
        .collect();
    let candidates = locate_clock(&frames);
    let roi = &candidates.first().expect("clock candidate").roi;
    assert!((roi.x + roi.w) * 320.0 >= 120.0, "{roi:?}");
    let learned = learn_clock(&frames, roi);
    assert!(learned.reason.is_none(), "{learned:?}");
    let profile = learned.profile.expect("profile from located ROI");
    for (i, frame) in frames.iter().enumerate().step_by(8) {
        assert_eq!(
            recognize_auto_frame(&frame.image, &profile).value,
            Some((82 - i / 8) as f64)
        );
    }
}

// A one-pixel-wide minute at the CLI's 960px analysis scale must not be
// confused with a colon or require a minimum digit aspect ratio.
fn shaped_clock(value: usize, format: usize) -> Image {
    let mut image = Image {
        data: vec![12; 960 * 540],
        width: 960,
        height: 540,
    };
    let symbols: Vec<usize> = match format {
        2 => vec![value / 10, value % 10],
        5 => vec![
            value / 600,
            value / 60 % 10,
            10,
            value % 60 / 10,
            value % 10,
        ],
        _ => vec![value / 60, 10, value % 60 / 10, value % 10],
    };
    let mut x = 331;
    for symbol in symbols {
        let font = if symbol == 1 { ["1"; 7] } else { FONT[symbol] };
        for (y, row) in font.iter().enumerate() {
            for (dx, p) in row.bytes().enumerate() {
                if p == b'1' {
                    image.data[(217 + y) * 960 + x + dx] = 240;
                }
            }
        }
        // Fixed digit advance, including the large whitespace after a narrow 1.
        x += if symbol == 10 { 4 } else { 8 };
    }
    image
}

#[test]
fn localises_narrow_one_and_all_clock_lengths_at_analysis_scale() {
    for (start, format) in [(100, 4), (115, 4), (600, 5), (5, 4), (25, 2)]
        .into_iter()
        .chain((1..=9).map(|m| (m * 60 + 35, 4)))
    {
        let frames: Vec<_> = (0..50)
            .map(|n| TimedFrame {
                time: n as f64 / 10.0,
                image: shaped_clock(start - n / 10, format),
            })
            .collect();
        let candidates = locate_clock(&frames);
        let top = candidates
            .first()
            .unwrap_or_else(|| panic!("no clock for {start}/{format}"));
        assert!((top.roi.x * 960.0 - 331.0).abs() < 3.0, "{top:?}");
        assert!((top.roi.y * 540.0 - 217.0).abs() < 3.0, "{top:?}");
    }
}

#[test]
fn clock_entering_after_cutaway_is_found_but_half_window_replay_is_rejected() {
    let frames: Vec<_> = (0..80)
        .map(|n| TimedFrame {
            time: n as f64 / 10.0,
            image: if n < 30 {
                Image {
                    data: vec![12; 960 * 540],
                    width: 960,
                    height: 540,
                }
            } else {
                shaped_clock(100 - n / 10, 4)
            },
        })
        .collect();
    assert!(!locate_clock(&frames).is_empty());
    let half: Vec<_> = frames
        .into_iter()
        .enumerate()
        .map(|(n, mut f)| {
            if n < 40 {
                f.image.data.fill(12);
            }
            f
        })
        .collect();
    assert!(locate_clock(&half).is_empty());
}

#[test]
fn a_colon_pair_cannot_absorb_a_third_aligned_scoreboard_fragment() {
    let mut image = shaped_clock(100, 4);
    for y in 229..233 {
        image.data[y * 960 + 339] = 240;
    }
    assert!(proposals(&image, 190)
        .iter()
        .any(|r| r.x >= 329.0 && r.x <= 331.0 && r.y == 216.0 && r.height <= 10.0));
}

#[test]
fn team_score_is_not_a_second_minutes_digit() {
    let frames: Vec<_> = (0..50)
        .map(|n| {
            let mut image = shaped_clock(100 - n / 10, 4);
            // Slightly larger score, close enough to share a component row, but
            // separated by more than a real digit advance.
            for y in 0..9 {
                for x in 0..8 {
                    if FONT[3][y * 7 / 9].as_bytes()[x * 5 / 8] == b'1' {
                        image.data[(216 + y) * 960 + 312 + x] = 240;
                    }
                }
            }
            TimedFrame {
                time: n as f64 / 10.0,
                image,
            }
        })
        .collect();
    let candidates = locate_clock(&frames);
    let top = candidates.first().expect("clock beside score");
    assert!(top.roi.x * 960.0 > 325.0, "{top:?}");
}

#[test]
fn learns_and_reads_narrow_one_two_minute_digits_and_seconds_only() {
    for (start, format) in [(100, 4), (625, 5), (25, 2)] {
        let frames: Vec<_> = (0..220)
            .map(|n| TimedFrame {
                time: n as f64 / 10.0,
                image: shaped_clock(start - n / 10, format),
            })
            .collect();
        let roi = RoiRect {
            x: 329.0 / 960.0,
            y: 215.0 / 540.0,
            w: 42.0 / 960.0,
            h: 11.0 / 540.0,
        };
        let learned = learn_clock(&frames, &roi);
        assert!(learned.reason.is_none(), "{start}/{format}: {learned:?}");
        let profile = learned.profile.unwrap();
        assert!(validate_profile(&serde_json::to_value(&profile).unwrap())["profile"].is_object());
        for n in 0..22 {
            let reading = recognize_auto_frame(&shaped_clock(start - n, format), &profile);
            assert_eq!(
                reading.value,
                Some((start - n) as f64),
                "{start}/{format}/{n}: {reading:?}"
            );
        }
    }
}
