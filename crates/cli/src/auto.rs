use super::{
    checked_output, emit, ffprobe_path, read_frame, stderr_tail, Decoder, Operation, Options,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Instant;
use stream_syncer_core::{
    learn_clock, locate_clock, recognize_auto_frame, roi_to_pixels, Image, RecognitionProfile,
    RoiCandidate, RoiRect, TickMoment, TickMomentDetector, TimedFrame,
};

const DISCOVERY_FPS: f64 = 10.0;
const MAX_DISCOVERY_BYTES: usize = 384 * 1024 * 1024;
const CONFIDENT: f64 = 0.82;

pub(super) fn parse_roi(value: &OsString) -> Result<RoiRect, String> {
    let fields: Vec<f64> = value
        .to_str()
        .ok_or("--roi 必须为 UTF-8")?
        .split(',')
        .map(|part| {
            part.parse::<f64>()
                .map_err(|_| "--roi 格式为 x,y,w,h".to_owned())
        })
        .collect::<Result<_, _>>()?;
    if fields.len() != 4 || fields.iter().any(|v| !v.is_finite()) {
        return Err("--roi 格式为有限数字 x,y,w,h".into());
    }
    let roi = RoiRect {
        x: fields[0],
        y: fields[1],
        w: fields[2],
        h: fields[3],
    };
    if roi.x < 0.0
        || roi.y < 0.0
        || roi.w <= 0.0
        || roi.h <= 0.0
        || roi.x + roi.w > 1.0
        || roi.y + roi.h > 1.0
    {
        return Err("--roi 必须位于 0..1 画面范围内且宽高大于 0".into());
    }
    Ok(roi)
}

struct VideoInfo {
    width: usize,
    height: usize,
    start_time: Option<f64>,
    duration: Option<f64>,
    native_fps: Option<f64>,
}

fn info(options: &Options, video: &Path) -> Result<VideoInfo, String> {
    let output = checked_output(
        Command::new(ffprobe_path(&options.ffmpeg))
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height,avg_frame_rate:format=start_time,duration",
                "-of",
                "json",
            ])
            .arg(video)
            .stdin(Stdio::null()),
        "ffprobe",
    )?;
    let value: Value =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("ffprobe JSON 无效: {e}"))?;
    let positive = |v: &Value| {
        v.as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .filter(|n| *n > 0)
    };
    let width = positive(&value["streams"][0]["width"]).ok_or("ffprobe 缺少有效宽度")?;
    let height = positive(&value["streams"][0]["height"]).ok_or("ffprobe 缺少有效高度")?;
    let finite = |v: &Value| {
        v.as_str()
            .and_then(|s| s.parse::<f64>().ok())
            .filter(|n| n.is_finite())
    };
    let native_fps = value["streams"][0]["avg_frame_rate"]
        .as_str()
        .and_then(|s| s.split_once('/'))
        .and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok()?))
        .filter(|v| v.is_finite() && *v > 0.0);
    Ok(VideoInfo {
        width,
        height,
        start_time: finite(&value["format"]["start_time"]),
        duration: finite(&value["format"]["duration"]),
        native_fps,
    })
}

// Only short discovery windows retain frames. Full runs keep one frame and tick metadata.
fn decode(
    options: &Options,
    video: &Path,
    from: f64,
    to: Option<f64>,
    fps: f64,
    width: usize,
    height: usize,
    transform: &str,
    mut visit: impl FnMut(&Image, f64) -> Result<(), String>,
) -> Result<u64, String> {
    let bytes = width
        .checked_mul(height)
        .filter(|n| *n <= 128 * 1024 * 1024)
        .ok_or("解码帧尺寸过大")?;
    let mut image = Image {
        data: vec![0; bytes],
        width,
        height,
    };
    // TS segments may not contain a decodable keyframe at the requested seek.
    // Decode a bounded preroll, then discard it with an output seek. Otherwise
    // fps=start_time=0 can pad the first missing seconds with a frozen image.
    let seek = (from - 10.0).max(0.0);
    let mut command = Command::new(&options.ffmpeg);
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-noautorotate",
            "-ss",
            &seek.to_string(),
            "-i",
        ])
        .arg(video)
        .args(["-ss", &(from - seek).to_string()]);
    if let Some(end) = to {
        command.args(["-t", &(end - from).to_string()]);
    }
    command
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            &format!("fps={fps}:start_time=0,{transform},format=gray"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut decoder = Decoder(
        command
            .spawn()
            .map_err(|e| format!("无法启动 ffmpeg: {e}"))?,
    );
    let mut stdout = decoder.0.stdout.take().ok_or("ffmpeg 缺少 stdout")?;
    let stderr = decoder.0.stderr.take().ok_or("ffmpeg 缺少 stderr")?;
    let diagnostics = thread::spawn(move || stderr_tail(stderr));
    let mut count = 0_u64;
    let result = (|| {
        while read_frame(&mut stdout, &mut image.data)? {
            let time = from + count as f64 / fps;
            if to.is_some_and(|end| time >= end) {
                break;
            }
            visit(&image, time)?;
            count += 1;
        }
        Ok::<_, String>(())
    })();
    drop(stdout);
    if result.is_err() {
        let _ = decoder.0.kill();
    }
    let status = decoder
        .0
        .wait()
        .map_err(|e| format!("等待 ffmpeg 失败: {e}"))?;
    let diagnostics = diagnostics.join().map_err(|_| "ffmpeg 诊断线程失败")?;
    result.map_err(|e| {
        if diagnostics.is_empty() {
            e.clone()
        } else {
            format!("{e}; ffmpeg: {diagnostics}")
        }
    })?;
    if !status.success() {
        return Err(format!("ffmpeg 解码失败 ({status}): {diagnostics}"));
    }
    Ok(count)
}

fn collect(
    options: &Options,
    video: &Path,
    info: &VideoInfo,
    from: f64,
    to: f64,
) -> Result<Vec<TimedFrame>, String> {
    let width = info.width.min(960);
    let height = ((info.height as f64 * width as f64 / info.width as f64).round() as usize).max(1);
    let estimated = (to - from) * DISCOVERY_FPS * (width * height) as f64;
    if estimated > MAX_DISCOVERY_BYTES as f64 {
        return Err("定位窗口超过 384MiB 帧预算".into());
    }
    let mut frames = Vec::new();
    decode(
        options,
        video,
        from,
        Some(to),
        DISCOVERY_FPS,
        width,
        height,
        &format!("scale={width}:{height}:flags=area"),
        |image, time| {
            if frames.len().saturating_mul(width * height) >= MAX_DISCOVERY_BYTES {
                return Err("定位帧预算已用尽".into());
            }
            frames.push(TimedFrame {
                time,
                image: image.clone(),
            });
            Ok(())
        },
    )?;
    Ok(frames)
}

fn crop(info: &VideoInfo, roi: &RoiRect) -> (usize, usize, String) {
    let r = roi_to_pixels(roi, info.width, info.height);
    (
        r.width as usize,
        r.height as usize,
        format!("crop={}:{}:{}:{}:exact=1", r.width, r.height, r.x, r.y),
    )
}

struct Learned {
    profile: Option<RecognitionProfile>,
    roi: RoiRect,
    windows: Vec<(f64, f64)>,
}

struct Training {
    learned: Option<Learned>,
    reason: Option<String>,
}

// Each decode is bounded independently, even when the requested range is a full file.
struct TrainingWindows {
    next: f64,
    end: Option<f64>,
    duration: f64,
}

impl Iterator for TrainingWindows {
    type Item = (f64, f64);

    fn next(&mut self) -> Option<Self::Item> {
        let from = self.next;
        let to = (from + self.duration).min(self.end.unwrap_or(f64::INFINITY));
        if !to.is_finite() || to <= from {
            return None;
        }
        self.next = to;
        Some((from, to))
    }
}

fn same_clock_region(a: &RoiRect, b: &RoiRect) -> bool {
    let intersection = ((a.x + a.w).min(b.x + b.w) - a.x.max(b.x)).max(0.0)
        * ((a.y + a.h).min(b.y + b.h) - a.y.max(b.y)).max(0.0);
    intersection / (a.w * a.h).min(b.w * b.h) >= 0.6
}

fn union_roi(a: &RoiRect, b: &RoiRect) -> RoiRect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    RoiRect {
        x,
        y,
        w: (a.x + a.w).max(b.x + b.w) - x,
        h: (a.y + a.h).max(b.y + b.h) - y,
    }
}

fn missing_characters(profile: &RecognitionProfile) -> Vec<&'static str> {
    stream_syncer_core::CLOCK_CHARS
        .iter()
        .copied()
        .filter(|c| profile.templates.get(*c).is_none_or(Vec::is_empty))
        .collect()
}

// New windows may fill gaps in a candidate profile, but never replace an existing
// label. Reject any exact mask that would acquire two different labels.
fn extend_profile(
    profile: &mut RecognitionProfile,
    candidate: &RecognitionProfile,
) -> Result<Vec<String>, &'static str> {
    for (label, samples) in &candidate.templates {
        for (other, existing) in &profile.templates {
            if label != other
                && samples
                    .iter()
                    .any(|sample| existing.iter().any(|old| old.data == sample.data))
            {
                return Err("conflicting-template-labels");
            }
        }
    }
    let mut added = Vec::new();
    for (label, samples) in &candidate.templates {
        if !samples.is_empty() && profile.templates.get(label).is_none_or(Vec::is_empty) {
            profile.templates.insert(label.clone(), samples.clone());
            added.push(label.clone());
        }
    }
    // Automatic recognition accepts all supported display lengths. Shape and
    // template confidence still determine whether an individual frame is usable.
    profile.clock_format = "auto".into();
    Ok(added)
}

// Timing alone cannot establish which of two persistent clocks is live.
fn ambiguous_candidates(candidates: &[RoiCandidate]) -> bool {
    let Some(first) = candidates.first() else {
        return false;
    };
    first.persistence >= 0.9
        && candidates.iter().skip(1).any(|other| {
            let a = &first.roi;
            let b = &other.roi;
            let disjoint =
                a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
            disjoint && other.persistence >= 0.9 && first.score - other.score <= 0.03
        })
}

fn train(
    options: &Options,
    video: &Path,
    source: &str,
    info: &VideoInfo,
    from: f64,
    to: f64,
    anchor: Option<&Learned>,
    writer: &mut impl Write,
) -> Result<Training, String> {
    let roi = if let Some(roi) = &options.roi {
        roi.clone()
    } else {
        let frames = collect(options, video, info, from, to)?;
        if frames.is_empty() {
            return Ok(Training {
                learned: None,
                reason: Some("no-video-frames".into()),
            });
        }
        let candidates = locate_clock(&frames);
        emit(
            writer,
            &json!({"type":"localization", "source":source, "video":video.to_string_lossy(), "from":from,"to":to,"sampleFps":DISCOVERY_FPS,"analysisWidth":frames[0].image.width,"candidates":candidates}),
        )?;
        if ambiguous_candidates(&candidates) {
            emit(
                writer,
                &json!({"type":"learning", "source":source,"from":from,"to":to,"profile":null,"reason":"ambiguous-clock-candidates","learnedChars":[]}),
            )?;
            return Ok(Training {
                learned: None,
                reason: Some("ambiguous-clock-candidates".into()),
            });
        }
        let Some(candidate) = candidates.first() else {
            emit(
                writer,
                &json!({"type":"learning", "source":source,"from":from,"to":to,"profile":null,"reason":"no-clock-candidate","learnedChars":[],"missingChars":["0","1","2","3","4","5","6","7","8","9",":"]}),
            )?;
            return Ok(Training {
                learned: None,
                reason: Some("no-clock-candidate".into()),
            });
        };
        if candidate.score < CONFIDENT {
            return Ok(Training {
                learned: None,
                reason: Some("low-localization-confidence".into()),
            });
        }
        if let Some(anchor) = anchor {
            if !same_clock_region(&anchor.roi, &candidate.roi) {
                return Ok(Training {
                    learned: None,
                    reason: Some("clock-region-changed".into()),
                });
            }
            union_roi(&anchor.roi, &candidate.roi)
        } else {
            candidate.roi.clone()
        }
    };
    let (width, height, transform) = crop(info, &roi);
    let mut frames = Vec::new();
    decode(
        options,
        video,
        from,
        Some(to),
        DISCOVERY_FPS,
        width,
        height,
        &transform,
        |image, time| {
            if frames.len().saturating_mul(width * height) >= MAX_DISCOVERY_BYTES {
                return Err("学习帧预算已用尽".into());
            }
            let mut image = image.clone();
            if let Some(profile) = anchor.and_then(|learned| learned.profile.as_ref()) {
                // Learn extension masks under the original preprocessing. On a
                // binary image every core learning threshold yields that mask.
                for pixel in &mut image.data {
                    *pixel = if f64::from(*pixel) >= profile.preprocess.threshold {
                        255
                    } else {
                        0
                    };
                }
            }
            frames.push(TimedFrame { time, image });
            Ok(())
        },
    )?;
    let local_roi = RoiRect {
        x: 0.0,
        y: 0.0,
        w: 1.0,
        h: 1.0,
    };
    let mut report = learn_clock(&frames, &local_roi);
    if let (Some(profile), Some(previous)) = (
        report.profile.as_mut(),
        anchor.and_then(|learned| learned.profile.as_ref()),
    ) {
        profile.preprocess = previous.preprocess.clone();
    }
    let accepted = report.profile.is_some()
        && report.reason.is_none()
        && report.consistent_offsets == 1
        && report.confidence >= CONFIDENT;
    let reason = (!accepted).then(|| {
        report
            .reason
            .clone()
            .unwrap_or_else(|| "insufficient-learning-confidence".into())
    });
    let mut profile = report.profile.take();
    if let Some(profile) = profile.as_mut() {
        profile.clock_format = "auto".into();
    }
    let mut serialized = serde_json::to_value(&report).map_err(|e| e.to_string())?;
    let exported = profile.as_ref().map(|profile| {
        let mut profile = profile.clone();
        profile.roi = roi.clone();
        profile
    });
    serialized["profile"] = serde_json::to_value(&exported).map_err(|e| e.to_string())?;
    emit(
        writer,
        &json!({"type":"learning","source":source,"roi":roi,"from":from,"to":to,"sampleFps":DISCOVERY_FPS,"accepted":accepted,"report":serialized}),
    )?;
    Ok(Training {
        learned: accepted.then_some(Learned {
            profile,
            roi,
            windows: vec![(from, to)],
        }),
        reason,
    })
}

fn scan_training(
    options: &Options,
    video: &Path,
    source: &str,
    info: &VideoInfo,
    writer: &mut impl Write,
) -> Result<Training, String> {
    let end = match (options.to, info.duration) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    let windows = TrainingWindows {
        next: options.from,
        end,
        duration: options.learn_duration,
    };
    select_training(windows, source, writer, |from, to, anchor, writer| {
        train(options, video, source, info, from, to, anchor, writer)
    })
}

fn select_training<W: Write>(
    windows: TrainingWindows,
    source: &str,
    writer: &mut W,
    mut train_window: impl FnMut(f64, f64, Option<&Learned>, &mut W) -> Result<Training, String>,
) -> Result<Training, String> {
    let mut selected: Option<Learned> = None;
    let mut last_reason = Some("no-usable-learning-window".into());
    for (from, to) in windows {
        let training = train_window(from, to, selected.as_ref(), writer)?;
        let Some(candidate) = training.learned else {
            let eof = training.reason.as_deref() == Some("no-video-frames");
            last_reason = training.reason;
            emit(
                writer,
                &json!({"type":"learning-window","source":source,"from":from,"to":to,"status":"rejected","reason":last_reason}),
            )?;
            if eof {
                break;
            }
            continue;
        };
        if let Some(learned) = selected.as_mut() {
            let added = extend_profile(
                learned
                    .profile
                    .as_mut()
                    .expect("accepted training has a profile"),
                candidate
                    .profile
                    .as_ref()
                    .expect("accepted training has a profile"),
            );
            match added {
                Ok(added) => {
                    learned.roi = candidate.roi;
                    if !added.is_empty() {
                        learned.windows.push((from, to));
                    }
                    emit(
                        writer,
                        &json!({"type":"learning-window","source":source,"from":from,"to":to,"status":"extended","addedChars":added,"roi":learned.roi,"missingChars":missing_characters(learned.profile.as_ref().unwrap())}),
                    )?;
                }
                Err(reason) => emit(
                    writer,
                    &json!({"type":"learning-window","source":source,"from":from,"to":to,"status":"rejected","reason":reason}),
                )?,
            }
        } else {
            emit(
                writer,
                &json!({"type":"learning-window","source":source,"from":from,"to":to,"status":"selected","roi":candidate.roi,"learnedChars":candidate.profile.as_ref().unwrap().templates.keys().collect::<Vec<_>>(),"missingChars":missing_characters(candidate.profile.as_ref().unwrap())}),
            )?;
            selected = Some(candidate);
        }
        if selected
            .as_ref()
            .and_then(|learned| learned.profile.as_ref())
            .is_some_and(|profile| missing_characters(profile).is_empty())
        {
            break;
        }
    }
    Ok(Training {
        reason: selected.is_none().then_some(last_reason).flatten(),
        learned: selected,
    })
}

#[derive(Clone, Debug)]
struct Tick {
    time: f64,
    value: Option<f64>,
    confidence: f64,
    offset_eligible: bool,
    offset_rejection_reason: Option<&'static str>,
}

#[derive(Default)]
struct TickQualifier {
    baseline: Option<(f64, f64)>,
}

impl TickQualifier {
    fn push(&mut self, time: f64, value: Option<f64>, confidence: f64) -> Option<&'static str> {
        let Some(value) = value.filter(|v| v.is_finite() && v.fract() == 0.0 && *v >= 0.0) else {
            self.baseline = None;
            return Some("unrecognized-value");
        };
        if confidence < CONFIDENT || !confidence.is_finite() {
            self.baseline = None;
            return Some("low-confidence");
        }
        let Some((previous_time, previous_value)) = self.baseline else {
            self.baseline = Some((time, value));
            return Some("no-countdown-baseline");
        };
        // Same-value compression changes are not clock ticks and must not move
        // the timing baseline of the actual displayed value.
        if value == previous_value {
            return Some("duplicate-value");
        }
        self.baseline = Some((time, value));
        if previous_value - value != 1.0 {
            return Some("not-strict-decrement");
        }
        if !(0.65..=1.35).contains(&(time - previous_time)) {
            return Some("abnormal-countdown-interval");
        }
        None
    }
}
struct Pending {
    moment: TickMoment,
    value: Option<f64>,
    text: Option<String>,
    confidence: f64,
    reason: Option<String>,
}

fn finish_tick(
    pending: Pending,
    source: &str,
    uncertainty: f64,
    writer: &mut impl Write,
    ticks: &mut Vec<Tick>,
    qualifier: &mut TickQualifier,
) -> Result<(), String> {
    let rejection = qualifier.push(pending.moment.tick_time, pending.value, pending.confidence);
    emit(
        writer,
        &json!({"type":"tick","source":source,"tickTime":pending.moment.tick_time,"value":pending.value,"text":pending.text,"confidence":pending.confidence,
        "lastUnchanged":pending.moment.last_unchanged,"firstChanged":pending.moment.first_changed,"change":pending.moment.change,"noiseFloor":pending.moment.noise_floor,
        "reason":pending.reason,"samplingUncertaintySeconds":uncertainty,
        "offsetEligible":rejection.is_none(),"offsetRejectionReason":rejection,
        "tickLowerBound":pending.moment.last_unchanged-uncertainty,"tickUpperBound":pending.moment.first_changed+uncertainty,
        "timebase":"file-relative-sampled"}),
    )?;
    ticks.push(Tick {
        time: pending.moment.tick_time,
        value: pending.value,
        confidence: pending.confidence,
        offset_eligible: rejection.is_none(),
        offset_rejection_reason: rejection,
    });
    Ok(())
}

fn analyze(
    options: &Options,
    video: &Path,
    source: &str,
    writer: &mut impl Write,
) -> Result<Vec<Tick>, String> {
    let started = Instant::now();
    let info = info(options, video)?;
    emit(
        writer,
        &json!({"type":"container","source":source,"video":video.to_string_lossy(),"width":info.width,"height":info.height,"startTime":info.start_time,"duration":info.duration,"nativeFps":info.native_fps,"note":"file-relative timestamps exclude container start_time; no wall-clock alignment inferred"}),
    )?;
    if options
        .to
        .unwrap_or(f64::INFINITY)
        .min(info.duration.unwrap_or(f64::INFINITY))
        <= options.from
    {
        return Err("学习窗口为空".into());
    }
    let training = scan_training(options, video, source, &info, writer)?;
    let training_seconds = started.elapsed().as_secs_f64();
    let Some(learned) = training.learned else {
        let width = info.width.min(960);
        let height =
            ((info.height as f64 * width as f64 / info.width as f64).round() as usize).max(1);
        let mut minutes = BTreeMap::<u64, u64>::new();
        let frames = decode(
            options,
            video,
            options.from,
            options.to,
            options.fps,
            width,
            height,
            &format!("scale={width}:{height}:flags=area"),
            |_, time| {
                *minutes.entry((time / 60.0).floor() as u64).or_default() += 1;
                Ok(())
            },
        )?;
        let elapsed = started.elapsed().as_secs_f64();
        emit(
            writer,
            &json!({"type":"summary","source":source,"frames":frames,"ticks":0,"confidentTicks":0,"confidentFraction":0,"offsetEligibleTicks":0,"offsetRejectionReasons":{},"ticksPerMinute":minutes.keys().map(|minute|json!({"minute":minute,"ticks":0,"confidentTicks":0,"offsetEligibleTicks":0})).collect::<Vec<_>>(),"status":"rejected","reason":training.reason,"containerStartTime":info.start_time,"trainingSeconds":training_seconds,"decodeAndRecognizeSeconds":elapsed,"processingFramesPerSecond":frames as f64/elapsed,"mediaSecondsPerProcessingSecond":frames as f64/options.fps/elapsed}),
        )?;
        return Ok(Vec::new());
    };
    let (width, height, transform) = crop(&info, &learned.roi);
    let mut detector = TickMomentDetector::new();
    let mut ticks = Vec::new();
    let mut qualifier = TickQualifier::default();
    let mut pending: Option<Pending> = None;
    let mut recognition_seconds = 0.0;
    let uncertainty = 1.0 / options.fps + info.native_fps.map(|fps| 1.0 / fps).unwrap_or(0.0);
    let mut frames_by_minute = BTreeMap::<u64, u64>::new();
    let frames = decode(
        options,
        video,
        options.from,
        options.to,
        options.fps,
        width,
        height,
        &transform,
        |image, time| {
            *frames_by_minute
                .entry((time / 60.0).floor() as u64)
                .or_default() += 1;
            let moment = detector.push(image, time);
            if moment.is_some()
                || pending
                    .as_ref()
                    .is_some_and(|tick| time - tick.moment.first_changed >= 0.16)
            {
                if let Some(tick) = pending.take() {
                    finish_tick(
                        tick,
                        source,
                        uncertainty,
                        writer,
                        &mut ticks,
                        &mut qualifier,
                    )?;
                }
            }
            if let Some(moment) = moment {
                pending = Some(Pending {
                    moment,
                    value: None,
                    text: None,
                    confidence: 0.0,
                    reason: Some("unrecognized-change".into()),
                });
            }
            if let (Some(tick), Some(profile)) = (pending.as_mut(), learned.profile.as_ref()) {
                let start = Instant::now();
                let reading = recognize_auto_frame(image, profile);
                recognition_seconds += start.elapsed().as_secs_f64();
                if reading.value.is_some() && reading.confidence >= tick.confidence {
                    tick.value = reading.value;
                    tick.text = reading.text;
                    tick.confidence = reading.confidence;
                    tick.reason = reading.reason;
                }
            }
            Ok(())
        },
    )?;
    if let Some(tick) = pending.take() {
        finish_tick(
            tick,
            source,
            uncertainty,
            writer,
            &mut ticks,
            &mut qualifier,
        )?;
    }
    let confident = ticks
        .iter()
        .filter(|t| t.value.is_some() && t.confidence >= CONFIDENT)
        .count();
    let eligible = ticks.iter().filter(|t| t.offset_eligible).count();
    let mut rejection_reasons = BTreeMap::<&str, u64>::new();
    for tick in &ticks {
        if let Some(reason) = tick.offset_rejection_reason {
            *rejection_reasons.entry(reason).or_default() += 1;
        }
    }
    let minutes:Vec<_>=frames_by_minute.keys().map(|minute| {
        let in_minute:Vec<_>=ticks.iter().filter(|t|(t.time/60.0).floor() as u64==*minute).collect();
        json!({"minute":minute,"ticks":in_minute.len(),"confidentTicks":in_minute.iter().filter(|t|t.value.is_some()&&t.confidence>=CONFIDENT).count(),"offsetEligibleTicks":in_minute.iter().filter(|t|t.offset_eligible).count()})
    }).collect();
    let training_windows: Vec<_> = learned
        .windows
        .iter()
        .map(|(from, to)| json!({"from":from,"to":to}))
        .collect();
    let elapsed = started.elapsed().as_secs_f64();
    emit(
        writer,
        &json!({"type":"summary","source":source,"video":video.to_string_lossy(),"status":if learned.profile.is_some(){"completed"}else{"rejected"},"reason":if learned.profile.is_some(){Value::Null}else{json!("template-learning-failed")},"roi":learned.roi,"learnedChars":learned.profile.as_ref().map(|p|p.templates.keys().collect::<Vec<_>>()).unwrap_or_default(),"learningWindow":training_windows.first(),"trainingWindows":training_windows,"from":options.from,"to":options.to,"sampleFps":options.fps,"frames":frames,"ticks":ticks.len(),"confidentTicks":confident,"confidentFraction":if ticks.is_empty(){0.0}else{confident as f64/ticks.len()as f64},"offsetEligibleTicks":eligible,"offsetRejectionReasons":rejection_reasons,"confidenceThreshold":CONFIDENT,"ticksPerMinute":minutes,"containerStartTime":info.start_time,"trainingSeconds":training_seconds,"recognitionSeconds":recognition_seconds,"decodeAndRecognizeSeconds":elapsed,"processingFramesPerSecond":frames as f64/elapsed,"mediaSecondsPerProcessingSecond":frames as f64/options.fps/elapsed,"samplingUncertaintySeconds":uncertainty,"timebase":"file-relative-sampled"}),
    )?;
    Ok(ticks)
}

fn quantile(sorted: &[f64], fraction: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let pos = (sorted.len() - 1) as f64 * fraction;
    let low = pos.floor() as usize;
    let high = pos.ceil() as usize;
    Some(sorted[low] + (sorted[high] - sorted[low]) * (pos - low as f64))
}
fn distribution(values: &[f64]) -> Value {
    if values.is_empty() {
        return json!({"count":0,"median":null,"spread":null});
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let median = quantile(&sorted, 0.5).unwrap();
    let mut deviations: Vec<_> = sorted.iter().map(|v| (v - median).abs()).collect();
    deviations.sort_by(f64::total_cmp);
    json!({"count":sorted.len(),"median":median,"spread":sorted.last().unwrap()-sorted[0],"min":sorted[0],"max":sorted.last().unwrap(),"p05":quantile(&sorted,0.05),"p95":quantile(&sorted,0.95),"medianAbsoluteDeviation":quantile(&deviations,0.5)})
}

fn estimate(official: &[Tick], commentary: &[Tick]) -> Value {
    let confident =
        |tick: &&Tick| tick.offset_eligible && tick.value.is_some() && tick.confidence >= CONFIDENT;
    let official: Vec<_> = official.iter().filter(confident).collect();
    let commentary: Vec<_> = commentary.iter().filter(confident).collect();
    let mut residuals = Vec::new();
    for a in &official {
        for b in &commentary {
            let offset = b.time - a.time;
            if a.value == b.value && offset.abs() <= 60.0 {
                residuals.push(offset);
            }
        }
    }
    residuals.sort_by(f64::total_cmp);
    let mut modes: Vec<Vec<f64>> = Vec::new();
    for value in residuals {
        if modes
            .last()
            .and_then(|mode| mode.last())
            .is_some_and(|last| value - last <= 0.5)
        {
            modes.last_mut().unwrap().push(value);
        } else {
            modes.push(vec![value]);
        }
    }
    modes.sort_by_key(|mode| std::cmp::Reverse(mode.len()));
    let candidate_modes: Vec<_> = modes.iter().map(|values| distribution(values)).collect();
    let reject = |reason: &str| json!({"type":"offset","status":"rejected","reason":reason,"estimate":distribution(&[]),"candidateModes":candidate_modes,"perMinute":[],"timebase":"file-relative-sampled"});
    let Some(values) = modes.first() else {
        return reject("no-matched-qualified-ticks");
    };
    // Repeated round values can support multiple equally coherent alignments.
    // An arbitrary near-zero tie-break would manufacture an offset.
    if modes
        .iter()
        .skip(1)
        .any(|other| other.len() >= 3 && other.len() as f64 >= values.len() as f64 * 0.8)
    {
        return reject("ambiguous-offset-modes");
    }
    let candidate_distribution = distribution(values);
    let p05 = candidate_distribution["p05"].as_f64().unwrap();
    let p95 = candidate_distribution["p95"].as_f64().unwrap();
    if p95 - p05 > 0.25 || candidate_distribution["spread"].as_f64().unwrap() > 0.5 {
        return reject("unstable-offset-dispersion");
    }
    let center = distribution(values)["median"].as_f64().unwrap();
    let mut used = BTreeSet::new();
    let mut matches = Vec::new();
    let mut minutes = BTreeMap::<u64, Vec<f64>>::new();
    for a in official {
        let best = commentary
            .iter()
            .enumerate()
            .filter(|(i, b)| {
                let residual = b.time - a.time;
                !used.contains(i)
                    && a.value == b.value
                    && residual >= values[0] - 1e-9
                    && residual <= values[values.len() - 1] + 1e-9
            })
            .min_by(|(_, a1), (_, b1)| {
                (a1.time - a.time - center)
                    .abs()
                    .total_cmp(&(b1.time - a.time - center).abs())
            });
        if let Some((i, b)) = best {
            used.insert(i);
            let offset = b.time - a.time;
            matches.push(offset);
            minutes
                .entry((a.time / 60.0).floor() as u64)
                .or_default()
                .push(offset);
        }
    }
    let per_minute: Vec<_> = minutes
        .into_iter()
        .map(|(minute, values)| json!({"minute":minute,"estimate":distribution(&values)}))
        .collect();
    json!({"type":"offset","status":if matches.len()>=3{"estimated"}else{"rejected"},"reason":if matches.len()>=3{Value::Null}else{json!("insufficient-matches")},"estimate":if matches.len()>=3{distribution(&matches)}else{distribution(&[])},"candidateModes":candidate_modes,"perMinute":per_minute,"matching":"only strict decrement transitions with 0.65..1.35s intervals; same confident value, unique nearest match in dominant residual cluster; candidate offsets within +/-60s","ambiguityPolicy":"reject secondary cluster with >=3 pairs and >=80% of primary support; reject primary p95-p05 >0.25s or full spread >0.5s","offsetSign":"commentary file seconds minus official file seconds for the same clock tick","timebase":"file-relative-sampled","note":"container start_time is reported independently for both files; this does not infer wall-clock alignment"})
}

pub(super) fn run(options: &Options, writer: &mut impl Write) -> Result<(), String> {
    match &options.operation {
        Operation::Locate(video) => {
            let info = info(options, video)?;
            let started = Instant::now();
            let to = options.to.unwrap();
            let frames = collect(options, video, &info, options.from, to)?;
            if frames.is_empty() {
                return Err("所选范围没有视频帧".into());
            }
            let candidates = locate_clock(&frames);
            emit(
                writer,
                &json!({"type":"localization","video":video.to_string_lossy(),"containerStartTime":info.start_time,"from":options.from,"to":to,"frames":frames.len(),"sampleFps":DISCOVERY_FPS,"analysisWidth":frames[0].image.width,"analysisHeight":frames[0].image.height,"candidates":candidates,"processingSeconds":started.elapsed().as_secs_f64(),"timebase":"file-relative-sampled"}),
            )
        }
        Operation::Learn { video, out } => {
            if out.exists() {
                return Err("输出文件已存在, 不覆盖用户预设".into());
            }
            let info = info(options, video)?;
            let training = train(
                options,
                video,
                "video",
                &info,
                options.from,
                options.to.unwrap(),
                None,
                writer,
            )?;
            let Some(learned) = training.learned else {
                return Err("无法定位倒计时, 未创建预设".into());
            };
            let Some(mut profile) = learned.profile else {
                return Err("无法唯一学习倒计时模板, 未创建预设".into());
            };
            profile.roi = learned.roi;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(out)
                .map_err(|e| format!("创建新预设失败: {e}"))?;
            serde_json::to_writer_pretty(&mut file, &profile)
                .map_err(|e| format!("写入预设失败: {e}"))?;
            file.write_all(b"\n")
                .map_err(|e| format!("写入预设失败: {e}"))?;
            emit(
                writer,
                &json!({"type":"profile-saved","path":out.to_string_lossy(),"newCandidate":true}),
            )
        }
        Operation::Recognize(video) => {
            analyze(options, video, "official", writer)?;
            Ok(())
        }
        Operation::Offset {
            official,
            commentary,
        } => {
            let a = analyze(options, official, "official", writer)?;
            let b = analyze(options, commentary, "commentary", writer)?;
            emit(writer, &estimate(&a, &b))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate_profile(characters: &str) -> RecognitionProfile {
        let mut profile: RecognitionProfile =
            serde_json::from_value(stream_syncer_core::empty_profile("test/countdown", "Test"))
                .unwrap();
        for c in characters.chars() {
            profile.templates.insert(
                c.to_string(),
                vec![stream_syncer_core::TemplateSample {
                    id: format!("test-{c}"),
                    data: c.to_string().repeat(256),
                    created_at: 0.0,
                    origin: None,
                }],
            );
        }
        profile
    }

    #[test]
    fn training_windows_cover_only_the_requested_range_with_bounded_memory() {
        let windows: Vec<_> = TrainingWindows {
            next: 17.0,
            end: Some(82.0),
            duration: 30.0,
        }
        .collect();
        assert_eq!(windows, vec![(17.0, 47.0), (47.0, 77.0), (77.0, 82.0)]);
        assert_eq!(
            TrainingWindows {
                next: 4.0,
                end: None,
                duration: 8.0,
            }
            .take(3)
            .collect::<Vec<_>>(),
            vec![(4.0, 12.0), (12.0, 20.0), (20.0, 28.0)]
        );
    }

    #[test]
    fn learning_skips_rejected_windows_then_extends_missing_zero_without_replacing_one() {
        let mut output = Vec::new();
        let mut attempted = Vec::new();
        let result = select_training(
            TrainingWindows {
                next: 100.0,
                end: Some(220.0),
                duration: 30.0,
            },
            "official",
            &mut output,
            |from, to, anchor, _| {
                attempted.push(from);
                if from == 100.0 {
                    assert!(anchor.is_none());
                    return Ok(Training {
                        learned: None,
                        reason: Some("ambiguous-countdown-labels".into()),
                    });
                }
                let profile = if from == 130.0 {
                    assert!(anchor.is_none());
                    candidate_profile("123456789:")
                } else {
                    assert!(anchor.is_some());
                    let mut profile = candidate_profile("0123456789:");
                    profile.templates.get_mut("1").unwrap()[0].id = "later-one".into();
                    profile
                };
                let roi = profile.roi.clone();
                Ok(Training {
                    learned: Some(Learned {
                        profile: Some(profile),
                        roi,
                        windows: vec![(from, to)],
                    }),
                    reason: None,
                })
            },
        )
        .unwrap();
        let learned = result.learned.unwrap();
        assert_eq!(attempted, vec![100.0, 130.0, 160.0]);
        assert_eq!(learned.windows, vec![(130.0, 160.0), (160.0, 190.0)]);
        let profile = learned.profile.unwrap();
        assert!(missing_characters(&profile).is_empty());
        assert_eq!(profile.templates["1"][0].id, "test-1");
        let events: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(events[0]["status"], "rejected");
        assert_eq!(events[1]["status"], "selected");
        assert_eq!(events[1]["from"], 130.0);
        assert_eq!(events[2]["addedChars"], json!(["0"]));
    }

    #[test]
    fn extension_rejects_conflicting_labels_before_mutating_a_profile() {
        let mut profile = candidate_profile("1");
        let mut later = candidate_profile("02");
        later.templates.get_mut("2").unwrap()[0].data = profile.templates["1"][0].data.clone();
        assert_eq!(
            extend_profile(&mut profile, &later),
            Err("conflicting-template-labels")
        );
        assert!(!profile.templates.contains_key("0"));
        assert_eq!(profile.templates.len(), 1);
    }

    #[test]
    fn eof_stops_unknown_duration_scanning_without_an_unbounded_loop() {
        let mut attempted = 0;
        let result = select_training(
            TrainingWindows {
                next: 0.0,
                end: None,
                duration: 30.0,
            },
            "official",
            &mut Vec::new(),
            |_, _, _, _| {
                attempted += 1;
                Ok(Training {
                    learned: None,
                    reason: Some("no-video-frames".into()),
                })
            },
        )
        .unwrap();
        assert_eq!(attempted, 1);
        assert!(result.learned.is_none());
        assert_eq!(result.reason.as_deref(), Some("no-video-frames"));
    }

    #[test]
    fn roi_extension_keeps_the_full_wider_minutes_digit() {
        let first = RoiRect {
            x: 0.48,
            y: 0.02,
            w: 0.03,
            h: 0.02,
        };
        let wider = RoiRect {
            x: 0.475,
            y: 0.02,
            w: 0.04,
            h: 0.02,
        };
        assert!(same_clock_region(&first, &wider));
        let combined = union_roi(&first, &wider);
        assert_eq!(combined.x, wider.x);
        assert!((combined.w - wider.w).abs() < 1e-12);
        let elsewhere = RoiRect { x: 0.1, ..wider };
        assert!(!same_clock_region(&first, &elsewhere));
    }

    #[test]
    fn equally_persistent_disjoint_clocks_are_not_selected_automatically() {
        let candidate = |x, score, persistence| RoiCandidate {
            roi: RoiRect {
                x,
                y: 0.1,
                w: 0.1,
                h: 0.05,
            },
            score,
            persistence,
            event_times: vec![],
            period: 1.0,
            jitter: 0.01,
            glyph_score: 1.0,
        };
        assert!(ambiguous_candidates(&[
            candidate(0.1, 0.95, 1.0),
            candidate(0.6, 0.93, 0.95)
        ]));
        assert!(!ambiguous_candidates(&[
            candidate(0.1, 0.95, 1.0),
            candidate(0.11, 0.94, 1.0)
        ]));
        assert!(!ambiguous_candidates(&[
            candidate(0.1, 0.95, 1.0),
            candidate(0.6, 0.90, 1.0)
        ]));
        assert!(!ambiguous_candidates(&[
            candidate(0.1, 0.95, 1.0),
            candidate(0.6, 0.94, 0.8)
        ]));
    }

    #[test]
    fn learn_refuses_an_existing_profile_before_decoding() {
        let name = format!(
            "stream-syncer-cli-existing-profile-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, b"user profile content").unwrap();
        let options = super::super::parse_options(
            vec![
                "learn".into(),
                "--video".into(),
                "missing.ts".into(),
                "--out".into(),
                path.as_os_str().to_owned(),
            ],
            None,
        )
        .unwrap()
        .unwrap();
        let result = run(&options, &mut Vec::new());
        let preserved = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(result.unwrap_err().contains("输出文件已存在"));
        assert_eq!(preserved, b"user profile content");
    }
    #[test]
    fn roi_rejects_nonfinite_and_outside_bounds() {
        for text in ["0,0,0,1", "0,0,NaN,1", ".9,0,.2,1", "0,0,1", "0,0,1,1,1"] {
            assert!(parse_roi(&text.into()).is_err());
        }
        assert!(parse_roi(&".2,.1,.3,.4".into()).is_ok());
    }
    #[test]
    fn matching_repeated_round_values_uses_consistent_time_residual() {
        let mut qualifier = TickQualifier::default();
        let a: Vec<_> = (0..40)
            .map(|i| {
                let time = i as f64;
                let value = Some((20 - i % 20) as f64);
                let reason = qualifier.push(time, value, 0.95);
                Tick {
                    time,
                    value,
                    confidence: 0.95,
                    offset_eligible: reason.is_none(),
                    offset_rejection_reason: reason,
                }
            })
            .collect();
        let b: Vec<_> = a
            .iter()
            .map(|t| Tick {
                time: t.time + 2.1,
                value: t.value,
                confidence: t.confidence,
                offset_eligible: t.offset_eligible,
                offset_rejection_reason: t.offset_rejection_reason,
            })
            .collect();
        let result = estimate(&a, &b);
        assert_eq!(result["estimate"]["count"], 38);
        assert!((result["estimate"]["median"].as_f64().unwrap() - 2.1).abs() < 1e-9);
        assert_eq!(estimate(&[], &[])["status"], "rejected");
    }

    #[test]
    fn only_strict_one_second_decrements_are_offset_eligible() {
        let mut qualifier = TickQualifier::default();
        assert_eq!(
            qualifier.push(0.0, Some(100.0), 0.95),
            Some("no-countdown-baseline")
        );
        assert_eq!(
            qualifier.push(0.3, Some(100.0), 0.95),
            Some("duplicate-value")
        );
        // The compression duplicate must not move the true tick's baseline.
        assert_eq!(qualifier.push(1.0, Some(99.0), 0.95), None);
        assert_eq!(
            qualifier.push(2.0, Some(115.0), 0.95),
            Some("not-strict-decrement")
        );
        assert_eq!(
            qualifier.push(2.2, Some(114.0), 0.95),
            Some("abnormal-countdown-interval")
        );
        assert_eq!(qualifier.push(3.2, Some(113.0), 0.95), None);
        assert_eq!(qualifier.push(4.2, None, 0.0), Some("unrecognized-value"));
        assert_eq!(
            qualifier.push(5.2, Some(111.0), 0.95),
            Some("no-countdown-baseline")
        );
        assert_eq!(
            qualifier.push(6.2, Some(110.0), 0.5),
            Some("low-confidence")
        );
        assert_eq!(
            qualifier.push(7.2, Some(109.0), 0.95),
            Some("no-countdown-baseline")
        );
        assert_eq!(qualifier.push(8.2, Some(108.0), 0.95), None);
    }

    fn qualified_run(from: f64, offset_step: f64) -> Vec<Tick> {
        let mut qualifier = TickQualifier::default();
        (0..12)
            .map(|i| {
                let time = from + i as f64 * (1.0 + offset_step);
                let value = Some(90.0 - i as f64);
                let rejection = qualifier.push(time, value, 0.95);
                Tick {
                    time,
                    value,
                    confidence: 0.95,
                    offset_eligible: rejection.is_none(),
                    offset_rejection_reason: rejection,
                }
            })
            .collect()
    }

    #[test]
    fn equally_supported_offset_modes_are_rejected() {
        let official = qualified_run(0.0, 0.0);
        let mut commentary = qualified_run(2.1, 0.0);
        commentary.extend(qualified_run(32.1, 0.0));
        let result = estimate(&official, &commentary);
        assert_eq!(result["status"], "rejected");
        assert_eq!(result["reason"], "ambiguous-offset-modes");
        assert!(result["estimate"]["median"].is_null());
        assert_eq!(result["candidateModes"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn dispersed_offset_and_isolated_readings_are_rejected() {
        let official = qualified_run(0.0, 0.0);
        let commentary = qualified_run(2.0, 0.08);
        assert_eq!(
            estimate(&official, &commentary)["reason"],
            "unstable-offset-dispersion"
        );
        let isolated_a = vec![qualified_run(0.0, 0.0).remove(0)];
        let isolated_b = vec![qualified_run(2.0, 0.0).remove(0)];
        assert_eq!(
            estimate(&isolated_a, &isolated_b)["reason"],
            "no-matched-qualified-ticks"
        );
    }
}
