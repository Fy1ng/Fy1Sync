use stream_syncer_core::{tighten_camera_box, CameraFrame, CameraTighten, RoiRect};

const W: usize = 320;
const H: usize = 200;
const TRUTH: [usize; 4] = [90, 50, 230, 160];

fn roi([l, t, r, b]: [usize; 4]) -> RoiRect {
    RoiRect {
        x: l as f64 / W as f64,
        y: t as f64 / H as f64,
        w: (r - l) as f64 / W as f64,
        h: (b - t) as f64 / H as f64,
    }
}

fn sample(
    seed: usize,
    inside: [u8; 3],
    outside: [u8; 3],
    blur: f64,
    radius: f64,
    boxes: &[[usize; 4]],
) -> Vec<u8> {
    let mut pixels = Vec::with_capacity(W * H * 4);
    for y in 0..H {
        for x in 0..W {
            let mut alpha: f64 = 0.0;
            for &[l, t, r, b] in boxes {
                let dx = ((x as f64 + 0.5 - (l + r) as f64 / 2.0).abs() - (r - l) as f64 / 2.0
                    + radius)
                    .max(0.0);
                let dy = ((y as f64 + 0.5 - (t + b) as f64 / 2.0).abs() - (b - t) as f64 / 2.0
                    + radius)
                    .max(0.0);
                let rectangle_distance = (x as f64 + 0.5 - l as f64)
                    .min(r as f64 - x as f64 - 0.5)
                    .min(y as f64 + 0.5 - t as f64)
                    .min(b as f64 - y as f64 - 0.5);
                let distance = if radius > 0.0 && dx > 0.0 && dy > 0.0 {
                    radius - dx.hypot(dy)
                } else {
                    rectangle_distance
                };
                alpha = alpha.max(if blur == 0.0 {
                    f64::from(distance >= 0.0)
                } else {
                    (0.5 + distance / blur).clamp(0.0, 1.0)
                });
            }
            // Deterministic compression-like noise changes every frame. No rectangle edge
            // is encoded in the noise, so all expected coordinates come from the scene.
            let noise = (((x * 13 + y * 7 + seed * 19) ^ (x * y + seed * 31)) % 5) as f64 - 2.0;
            for c in 0..3 {
                pixels.push(
                    (outside[c] as f64 * (1.0 - alpha) + inside[c] as f64 * alpha + noise)
                        .clamp(0.0, 255.0)
                        .round() as u8,
                );
            }
            pixels.push(255);
        }
    }
    pixels
}

fn detect(samples: Vec<Vec<u8>>, rough: [usize; 4]) -> CameraTighten {
    let frames: Vec<_> = samples
        .into_iter()
        .map(|data| CameraFrame {
            width: W,
            height: H,
            data,
        })
        .collect();
    tighten_camera_box(&frames, &roi(rough))
}

fn assert_truth(result: CameraTighten, truth: [usize; 4], tolerance: f64) {
    let actual = [
        result.roi.x * W as f64,
        result.roi.y * H as f64,
        (result.roi.x + result.roi.w) * W as f64,
        (result.roi.y + result.roi.h) * H as f64,
    ];
    assert_eq!(result.found, [true; 4], "actual={actual:?}");
    assert!(
        actual
            .iter()
            .zip(truth)
            .all(|(a, b)| (a - b as f64).abs() <= tolerance),
        "actual={actual:?}, truth={truth:?}"
    );
}

#[test]
fn camera_isoluminant_chromatic_boundary_survives_color_conversion() {
    let samples = (0..6)
        .map(|s| sample(s, [210, 30, 30], [30, 80, 250], 0.0, 0.0, &[TRUTH]))
        .collect();
    assert_truth(detect(samples, [65, 25, 260, 180]), TRUTH, 1.0);
}

#[test]
fn camera_soft_low_contrast_edges_are_located_at_the_transition_center() {
    let samples = (0..6)
        .map(|s| sample(s, [104; 3], [72; 3], 8.0, 0.0, &[TRUTH]))
        .collect();
    assert_truth(detect(samples, [65, 25, 260, 180]), TRUTH, 2.0);
}

#[test]
fn camera_rounded_corners_do_not_require_a_sharp_corner_pixel() {
    let samples = (0..6)
        .map(|s| sample(s, [175, 90, 75], [40, 55, 75], 2.0, 18.0, &[TRUTH]))
        .collect();
    assert_truth(detect(samples, [65, 25, 260, 180]), TRUTH, 2.0);
}

#[test]
fn camera_two_equally_supported_targets_do_not_choose_one_or_union_them() {
    let boxes = [[40, 55, 125, 150], [190, 55, 275, 150]];
    let samples = (0..6)
        .map(|s| sample(s, [190; 3], [45; 3], 0.0, 0.0, &boxes))
        .collect();
    let rough = [25, 35, 295, 175];
    let result = detect(samples, rough);
    assert_eq!(result.found, [false; 4], "{:?}", result.roi);
    assert!(result.ambiguous);
    assert_eq!(
        serde_json::to_value(result.roi).unwrap(),
        serde_json::to_value(roi(rough)).unwrap()
    );
}

#[test]
fn camera_nothing_but_changing_texture_keeps_the_box() {
    let samples = (0..6)
        .map(|s| sample(s, [175, 90, 75], [65, 70, 75], 0.0, 0.0, &[]))
        .collect();
    let rough = [65, 25, 260, 180];
    let result = detect(samples, rough);
    assert_eq!(result.found, [false; 4]);
    assert_eq!(
        serde_json::to_value(result.roi).unwrap(),
        serde_json::to_value(roi(rough)).unwrap()
    );
}

#[test]
fn camera_a_single_frame_cannot_establish_a_persistent_boundary() {
    let result = detect(
        vec![sample(0, [190; 3], [45; 3], 0.0, 0.0, &[TRUTH])],
        [65, 25, 260, 180],
    );
    assert_eq!(result.found, [false; 4]);
}

#[test]
fn camera_soft_outer_boundary_is_not_replaced_by_a_sharp_monitor_inside() {
    let samples = (0..6)
        .map(|s| {
            let mut frame = sample(s, [104; 3], [72; 3], 8.0, 0.0, &[TRUTH]);
            for y in 74..134 {
                for x in 125..195 {
                    let index = (y * W + x) * 4;
                    frame[index..index + 3].fill(225);
                }
            }
            frame
        })
        .collect();
    assert_truth(detect(samples, [65, 25, 260, 180]), TRUTH, 2.0);
}

#[test]
fn camera_color_and_soft_edge_detection_generalizes_across_sizes_and_positions() {
    for (index, truth) in [
        [42, 32, 115, 94],
        [170, 105, 278, 179],
        [65, 65, 214, 153],
        [100, 30, 260, 116],
    ]
    .into_iter()
    .enumerate()
    {
        for blur in [0.0, 4.0, 8.0] {
            let samples = (0..6)
                .map(|s| {
                    sample(
                        s + index * 7,
                        [165, 62, 51],
                        [56, 105, 100],
                        blur,
                        0.0,
                        &[truth],
                    )
                })
                .collect();
            let rough = [truth[0] - 16, truth[1] - 16, truth[2] + 16, truth[3] + 16];
            assert_truth(detect(samples, rough), truth, 2.0);
        }
    }
}

#[test]
fn camera_color_boundary_at_the_video_edge_keeps_that_side_fixed() {
    let truth = [0, 50, 145, 158];
    let samples = (0..6)
        .map(|s| sample(s, [210, 30, 30], [30, 80, 250], 0.0, 0.0, &[truth]))
        .collect();
    let result = detect(samples, [0, 30, 165, 175]);
    assert_eq!(result.found, [false, true, true, true]);
    assert_eq!(result.roi.x, 0.0);
    assert!((result.roi.y * H as f64 - truth[1] as f64).abs() <= 1.0);
    assert!((result.roi.w * W as f64 - truth[2] as f64).abs() <= 1.0);
    assert!(((result.roi.y + result.roi.h) * H as f64 - truth[3] as f64).abs() <= 1.0);
}

#[test]
fn camera_rejects_malformed_rgba_and_unbounded_analysis_sizes() {
    let rough = roi([65, 25, 260, 180]);
    for frames in [
        vec![],
        vec![
            CameraFrame {
                width: 961,
                height: 1,
                data: vec![0; 961 * 4]
            };
            6
        ],
        vec![
            CameraFrame {
                width: W,
                height: H,
                data: vec![0; W * H]
            };
            6
        ],
        vec![
            CameraFrame {
                width: W,
                height: H,
                data: vec![0; W * H * 4]
            };
            9
        ],
        vec![
            CameraFrame {
                width: usize::MAX,
                height: usize::MAX,
                data: vec![]
            };
            6
        ],
    ] {
        assert_eq!(tighten_camera_box(&frames, &rough).found, [false; 4]);
    }
}

#[test]
fn camera_full_analysis_extent_keeps_the_localization_and_bounded_runtime() {
    let frames: Vec<_> = (0..6)
        .map(|seed| {
            let source = sample(seed, [165, 62, 51], [56, 105, 100], 0.0, 0.0, &[TRUTH]);
            let mut data = Vec::with_capacity(960 * 600 * 4);
            for y in 0..600 {
                for x in 0..960 {
                    let index = ((y / 3) * W + x / 3) * 4;
                    data.extend_from_slice(&source[index..index + 4]);
                }
            }
            CameraFrame {
                width: 960,
                height: 600,
                data,
            }
        })
        .collect();
    let start = std::time::Instant::now();
    let result = tighten_camera_box(&frames, &roi([15, 10, 305, 190]));
    let actual = [
        result.roi.x * 960.0,
        result.roi.y * 600.0,
        (result.roi.x + result.roi.w) * 960.0,
        (result.roi.y + result.roi.h) * 600.0,
    ];
    assert!(
        actual
            .iter()
            .zip(TRUTH)
            .all(|(a, b)| (a - (b * 3) as f64).abs() <= 2.0),
        "{actual:?}"
    );
    eprintln!("camera 960x600 / 6 RGBA frames: {:?}", start.elapsed());
}
