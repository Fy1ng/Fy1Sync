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
fn invalid_images_and_changed_dimensions_reset_the_tick_history() {
    let mut detector = TickMomentDetector::new();
    let image = Image { data: vec![240; 4], width: 2, height: 2 };
    assert!(detector.push(&image, 0.0).is_none());
    let invalid = Image { data: vec![0; 3], width: 2, height: 2 };
    assert!(detector.push(&invalid, 1.0).is_none());
    assert!(detector.push(&image, 2.0).is_none());
    assert!(detector.push(&image, f64::NAN).is_none());
    assert!(detector.push(&image, 3.0).is_none());
    let resized = Image { data: vec![0; 6], width: 3, height: 2 };
    assert!(detector.push(&resized, 4.0).is_none());
    assert!(detector.push(&resized, 3.0).is_none());
}
