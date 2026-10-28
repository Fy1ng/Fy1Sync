use super::*;

include!("score_test_fixtures.rs");

const W: usize = 480;
const H: usize = 140;

fn clock() -> RoiRect {
    RoiRect {
        x: 200.0 / W as f64,
        y: 35.0 / H as f64,
        w: 80.0 / W as f64,
        h: 44.0 / H as f64,
    }
}
fn paint(
    frame: &mut [u8],
    mask: &[u8],
    mw: usize,
    mh: usize,
    x: usize,
    y: usize,
    height: usize,
    color: [u8; 3],
) -> usize {
    let width = (height * mw / mh).max(1);
    for yy in 0..height {
        for xx in 0..width {
            if mask[(yy * mh / height) * mw + xx * mw / width] != 0 {
                let p = ((y + yy) * W + x + xx) * 4;
                frame[p..p + 3].copy_from_slice(&color);
                frame[p + 3] = 255;
            }
        }
    }
    width
}

fn fixture(digit: u8) -> &'static (u8, usize, usize, &'static str, &'static str) {
    HELD_OUT.iter().find(|f| f.0 == digit).unwrap()
}

#[test]
fn all_labeled_digits_and_two_digit_integers() {
    for digit in 0..=9 {
        let template = bank().iter().find(|g| g.digit == digit).unwrap();
        let mut frame = vec![0; W * H * 4];
        paint(
            &mut frame,
            &template.mask,
            32,
            48,
            120,
            30,
            72,
            [255, 255, 255],
        );
        paint(
            &mut frame,
            &template.mask,
            32,
            48,
            330,
            30,
            72,
            [15, 170, 225],
        );
        let result = recognize_score(&frame, W, H, &clock());
        assert_eq!(
            (result.left, result.right),
            (Some(digit), Some(digit)),
            "digit {digit}: {result:?}"
        );
    }
    for value in [10, 11, 19, 20, 42, 68, 99] {
        let mut frame = vec![0; W * H * 4];
        let mut x = 85;
        for digit in [value / 10, value % 10] {
            let glyph = bank().iter().find(|g| g.digit == digit).unwrap();
            x += paint(&mut frame, &glyph.mask, 32, 48, x, 30, 72, [255, 255, 255]) + 4;
        }
        let result = recognize_score(&frame, W, H, &clock());
        assert_eq!(result.left, Some(value), "{value}: {result:?}");
    }
}

#[test]
fn independent_native_upright_italic_and_color_holdouts() {
    for &(digit, mw, mh, data, source) in HELD_OUT {
        let mask = unpack_bitmap(data, mw * mh).unwrap();
        for color in [[255, 255, 255], [10, 170, 225], [225, 126, 10]] {
            let mut frame = vec![0; W * H * 4];
            paint(&mut frame, &mask, mw, mh, 120, 30, 72, color);
            let result = recognize_score(&frame, W, H, &clock());
            assert_eq!(result.left, Some(digit), "{source}, {color:?}: {result:?}");
            assert_eq!(result.right, None);
        }
    }
}

#[test]
fn nine_to_ten_native_glyphs() {
    for value in [9, 10] {
        let mut frame = vec![0; W * H * 4];
        let digits = if value == 9 { vec![9] } else { vec![1, 0] };
        let mut x = 100;
        for digit in digits {
            let &(_, mw, mh, data, _) = fixture(digit);
            let mask = unpack_bitmap(data, mw * mh).unwrap();
            x += paint(&mut frame, &mask, mw, mh, x, 30, 72, [10, 170, 225]) + 5;
        }
        assert_eq!(recognize_score(&frame, W, H, &clock()).left, Some(value));
    }
}

#[test]
fn blank_single_side_missing_and_interfering_digits() {
    let mut frame = vec![0; W * H * 4];
    assert!(recognize_score(&frame, W, H, &clock()).left.is_none());
    let &(_, mw, mh, data, _) = fixture(8);
    let mask = unpack_bitmap(data, mw * mh).unwrap();
    paint(&mut frame, &mask, mw, mh, 330, 30, 72, [255, 255, 255]);
    // A readable digit outside the clock-derived candidate is not a score.
    paint(&mut frame, &mask, mw, mh, 15, 30, 72, [255, 255, 255]);
    let result = recognize_score(&frame, W, H, &clock());
    assert_eq!((result.left, result.right), (None, Some(8)));
    assert_eq!(result.reason.as_deref(), Some("left-unreadable"));
}

#[test]
fn ambiguous_labels_and_multiple_candidate_numbers_are_rejected() {
    let template = bank()[0].clone();
    let ambiguous = vec![
        template.clone(),
        LabeledGlyph {
            digit: (template.digit + 1) % 10,
            ..template.clone()
        },
    ];
    assert!(match_digit(&template.mask, &ambiguous).is_none());
    let &(_, mw, mh, data, _) = fixture(8);
    let mask = unpack_bitmap(data, mw * mh).unwrap();
    let mut frame = vec![0; W * H * 4];
    for x in [50, 100, 150] {
        paint(&mut frame, &mask, mw, mh, x, 30, 60, [255, 255, 255]);
    }
    let result = recognize_score(&frame, W, H, &clock());
    assert_eq!(result.left, None);
    assert_eq!(result.reason.as_deref(), Some("ambiguous-candidates"));
}

#[test]
fn invalid_frames_and_clipped_roi_fail_closed() {
    assert_eq!(
        recognize_score(&[], 0, 0, &clock()).reason.as_deref(),
        Some("invalid-frame")
    );
    let bad = RoiRect {
        x: f64::NAN,
        ..clock()
    };
    assert_eq!(
        recognize_score(&vec![0; W * H * 4], W, H, &bad)
            .reason
            .as_deref(),
        Some("invalid-clock-roi")
    );
}
