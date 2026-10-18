use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::env;
use std::ffi::OsString;
use std::fs;
use std::io::{self, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread;
use std::time::Instant;
use stream_syncer_core::{dispatch, ClockJumpDetector, Engine};

mod auto;

const HELP: &str = "离线录像识别工具\n\nstream-syncer-cli locate --video <file> [--from s] [--duration s]\nstream-syncer-cli learn --video <file> [--roi x,y,w,h] [--from s] [--duration s] --out <new-profile.json>\nstream-syncer-cli recognize (--profile <json> | --auto) --video <file> [--from s] [--to s] [--fps n]\nstream-syncer-cli offset (--profile <json> | --auto) --official <file> --commentary <file> [--from s] [--to s] [--fps n]\n\n所有命令支持 --ffmpeg path. 自动模式支持 --learn-duration s (默认 30, 最长 60).\n--from 默认 0, --duration 默认 30, --to 为不含终点的结束时间.\n旧模式 --fps 默认 30; 自动模式默认 60, 定位/学习采样 10fps.\nffmpeg 来源: --ffmpeg, STREAM_SYNC_FFMPEG, PATH. ffprobe 使用同目录程序.\n输出为 JSONL. 自动模式报告采样边界和容器 start_time, 时间是文件相对秒数.\n两路录像起点不自动对齐, 不推测墙上时钟或录制开始时间差.\n";

#[derive(Debug, PartialEq)]
enum Operation {
    Locate(PathBuf),
    Learn {
        video: PathBuf,
        out: PathBuf,
    },
    Recognize(PathBuf),
    Offset {
        official: PathBuf,
        commentary: PathBuf,
    },
}

#[derive(Debug)]
struct Options {
    operation: Operation,
    profile: Option<PathBuf>,
    automatic: bool,
    roi: Option<stream_syncer_core::RoiRect>,
    learn_duration: f64,
    from: f64,
    to: Option<f64>,
    fps: f64,
    ffmpeg: PathBuf,
}

fn number(value: &OsString, flag: &str) -> Result<f64, String> {
    value
        .to_str()
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .ok_or_else(|| format!("{flag} 必须是有限数字"))
}

fn parse_options(
    args: Vec<OsString>,
    ffmpeg_env: Option<OsString>,
) -> Result<Option<Options>, String> {
    if args.is_empty() || args[0] == "--help" || args[0] == "-h" {
        return Ok(None);
    }
    let operation = args[0].to_str().ok_or("命令不是有效 UTF-8")?;
    if !matches!(operation, "recognize" | "offset" | "locate" | "learn") {
        return Err(format!("未知命令: {operation}"));
    }
    let mut flags = BTreeMap::new();
    let mut index = 1;
    while index < args.len() {
        let flag = args[index].to_str().ok_or("参数名不是有效 UTF-8")?;
        if flag == "--auto" && matches!(operation, "recognize" | "offset") {
            if flags
                .insert(flag.to_owned(), OsString::from("true"))
                .is_some()
            {
                return Err(format!("参数重复: {flag}"));
            }
            index += 1;
            continue;
        }
        let allowed = matches!(flag, "--from" | "--duration" | "--ffmpeg")
            || (matches!(operation, "recognize" | "offset")
                && matches!(flag, "--profile" | "--to" | "--fps" | "--learn-duration"))
            || (matches!(operation, "recognize" | "locate" | "learn") && flag == "--video")
            || (operation == "learn" && matches!(flag, "--roi" | "--out"))
            || (operation == "offset" && matches!(flag, "--official" | "--commentary"));
        if !allowed {
            return Err(format!("未知参数: {flag}"));
        }
        let value = args
            .get(index + 1)
            .ok_or_else(|| format!("{flag} 缺少值"))?;
        if value.to_str().is_some_and(|text| text.starts_with("--")) {
            return Err(format!("{flag} 缺少值"));
        }
        if flags.insert(flag.to_owned(), value.clone()).is_some() {
            return Err(format!("参数重复: {flag}"));
        }
        index += 2;
    }
    let required_path = |flag: &str| -> Result<PathBuf, String> {
        flags
            .get(flag)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .ok_or_else(|| format!("缺少参数: {flag}"))
    };
    let automatic = flags.contains_key("--auto");
    let profile = flags.get("--profile").map(PathBuf::from);
    if matches!(operation, "recognize" | "offset") && automatic == profile.is_some() {
        return Err("必须且只能指定 --profile 或 --auto".into());
    }
    let operation = match operation {
        "recognize" => Operation::Recognize(required_path("--video")?),
        "locate" => Operation::Locate(required_path("--video")?),
        "learn" => Operation::Learn {
            video: required_path("--video")?,
            out: required_path("--out")?,
        },
        _ => Operation::Offset {
            official: required_path("--official")?,
            commentary: required_path("--commentary")?,
        },
    };
    let from = flags
        .get("--from")
        .map(|value| number(value, "--from"))
        .transpose()?
        .unwrap_or(0.0);
    let mut to = flags
        .get("--to")
        .map(|value| number(value, "--to"))
        .transpose()?;
    if let Some(duration) = flags.get("--duration") {
        if to.is_some() {
            return Err("--duration 与 --to 不能同时指定".into());
        }
        let duration = number(duration, "--duration")?;
        if duration <= 0.0 {
            return Err("--duration 必须大于 0".into());
        }
        to = Some(from + duration);
    }
    if to.is_none() && matches!(operation, Operation::Locate(_) | Operation::Learn { .. }) {
        to = Some(from + 30.0);
    }
    let learn_duration = flags
        .get("--learn-duration")
        .map(|value| number(value, "--learn-duration"))
        .transpose()?
        .unwrap_or(30.0);
    if !(3.0..=60.0).contains(&learn_duration) {
        return Err("--learn-duration 必须在 3..60 秒内".into());
    }
    if matches!(operation, Operation::Locate(_) | Operation::Learn { .. })
        && to.unwrap() - from > 60.0
    {
        return Err("定位/学习窗口最长 60 秒".into());
    }
    let roi = flags
        .get("--roi")
        .map(|value| auto::parse_roi(value))
        .transpose()?;
    let fps = flags
        .get("--fps")
        .map(|value| number(value, "--fps"))
        .transpose()?
        .unwrap_or(if automatic { 60.0 } else { 30.0 });
    if from < 0.0 || to.is_some_and(|end| !end.is_finite() || end <= from) {
        return Err("时间范围要求 0 <= from < to".to_owned());
    }
    if fps <= 0.0 {
        return Err("--fps 必须大于 0".to_owned());
    }
    let ffmpeg = flags
        .get("--ffmpeg")
        .cloned()
        .or(ffmpeg_env)
        .unwrap_or_else(|| OsString::from("ffmpeg"));
    if ffmpeg.is_empty() {
        return Err("ffmpeg 路径不能为空".to_owned());
    }
    Ok(Some(Options {
        operation,
        profile,
        automatic,
        roi,
        learn_duration,
        from,
        to,
        fps,
        ffmpeg: ffmpeg.into(),
    }))
}

fn ffprobe_path(ffmpeg: &Path) -> PathBuf {
    let name = if ffmpeg
        .extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("exe"))
    {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    ffmpeg.parent().unwrap_or_else(|| Path::new("")).join(name)
}

fn checked_output(command: &mut Command, label: &str) -> Result<Output, String> {
    let output = command
        .output()
        .map_err(|error| format!("无法启动 {label}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{label} 失败 ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output)
}

fn dimensions(ffmpeg: &Path, video: &Path) -> Result<(usize, usize), String> {
    let output = checked_output(
        Command::new(ffprobe_path(ffmpeg))
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "json",
            ])
            .arg(video)
            .stdin(Stdio::null()),
        "ffprobe",
    )?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("ffprobe JSON 无效: {error}"))?;
    let stream = &value["streams"][0];
    let width = stream["width"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0);
    let height = stream["height"]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0);
    width
        .zip(height)
        .ok_or_else(|| "ffprobe 未返回有效视频尺寸".to_owned())
}

fn read_frame(reader: &mut impl Read, frame: &mut [u8]) -> Result<bool, String> {
    let mut filled = 0;
    while filled < frame.len() {
        match reader.read(&mut frame[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => {
                return Err(format!(
                    "ffmpeg 返回不完整 RGBA 帧: {filled}/{} 字节",
                    frame.len()
                ))
            }
            Ok(count) => filled += count,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(format!("读取 ffmpeg 帧失败: {error}")),
        }
    }
    Ok(true)
}

// Drain concurrently so decoder diagnostics cannot fill a pipe and block stdout.
fn stderr_tail(mut reader: impl Read) -> String {
    const MAX_BYTES: usize = 32 * 1024;
    let mut tail = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                tail.extend_from_slice(&chunk[..count]);
                if tail.len() > MAX_BYTES {
                    tail.drain(..tail.len() - MAX_BYTES);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&tail).trim().to_owned()
}

// Any early error, including a broken JSONL consumer, must reap the decoder.
struct Decoder(Child);

impl Drop for Decoder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn emit(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    serde_json::to_writer(&mut *writer, value)
        .map_err(|error| format!("写入 JSONL 失败: {error}"))?;
    writer
        .write_all(b"\n")
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写入 JSONL 失败: {error}"))
}

fn recognize_video(
    options: &Options,
    profile: &str,
    video: &Path,
    source: &str,
    writer: &mut impl Write,
) -> Result<Vec<Value>, String> {
    let mut engine = Engine::new();
    let readiness = engine.configure(profile)?;
    let (width, height) = dimensions(&options.ffmpeg, video)?;
    let frame_bytes = width
        .checked_mul(height)
        .and_then(|value| value.checked_mul(4))
        .ok_or("视频尺寸溢出")?;
    // Avoid allocation panics on corrupt metadata, without imposing a video-resolution policy.
    let mut frame = Vec::new();
    frame
        .try_reserve_exact(frame_bytes)
        .map_err(|error| format!("无法分配帧缓冲: {error}"))?;
    frame.resize(frame_bytes, 0);
    let mut command = Command::new(&options.ffmpeg);
    command
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-noautorotate",
            "-i",
        ])
        .arg(video)
        .args(["-ss", &options.from.to_string()]);
    if let Some(to) = options.to {
        command.args(["-t", &(to - options.from).to_string()]);
    }
    command
        .args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            &format!("fps={}:start_time=0", options.fps),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "pipe:1",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut decoder = Decoder(
        command
            .spawn()
            .map_err(|error| format!("无法启动 ffmpeg: {error}"))?,
    );
    let mut stdout = decoder.0.stdout.take().ok_or("ffmpeg 未提供 stdout")?;
    let stderr = decoder.0.stderr.take().ok_or("ffmpeg 未提供 stderr")?;
    let diagnostics = thread::spawn(move || stderr_tail(stderr));
    let started = Instant::now();
    let mut detector = ClockJumpDetector::new(source, json!({}));
    let mut events = Vec::new();
    let mut frames = 0_u64;
    let mut recognition_ms = 0.0_f64;
    let mut statuses =
        BTreeMap::from([("success".to_owned(), 0_u64), ("failed".to_owned(), 0_u64)]);
    let mut failures = BTreeMap::<String, u64>::new();
    let result = (|| -> Result<(), String> {
        while read_frame(&mut stdout, &mut frame)? {
            let media_time = options.from + frames as f64 / options.fps;
            let clock = Instant::now();
            let recognition = engine.recognize(
                &frame,
                width,
                height,
                media_time,
                media_time * 1000.0,
                frames as f64,
                false,
            );
            recognition_ms += clock.elapsed().as_secs_f64() * 1000.0;
            let outcome = &recognition["outcome"];
            let status = outcome["status"].as_str().ok_or("识别核心未返回 status")?;
            *statuses.entry(status.to_owned()).or_default() += 1;
            if let Some(reason) = outcome["reason"].as_str() {
                *failures.entry(reason.to_owned()).or_default() += 1;
            }
            let pushed = detector.push(outcome.clone());
            if let Some(event) = pushed.get("event").filter(|event| !event.is_null()) {
                emit(
                    writer,
                    &json!({"type": "jump", "source": source, "event": event}),
                )?;
                events.push(event.clone());
            }
            frames += 1;
        }
        Ok(())
    })();
    drop(stdout);
    if result.is_err() {
        let _ = decoder.0.kill();
    }
    let exit_status = decoder
        .0
        .wait()
        .map_err(|error| format!("等待 ffmpeg 失败: {error}"))?;
    let stderr = diagnostics
        .join()
        .map_err(|_| "读取 ffmpeg 错误输出的线程失败".to_owned())?;
    if let Err(error) = result {
        return Err(if stderr.is_empty() {
            error
        } else {
            format!("{error}; ffmpeg: {stderr}")
        });
    }
    if !exit_status.success() {
        return Err(format!("ffmpeg 解码失败 ({exit_status}): {stderr}"));
    }
    if frames == 0 {
        return Err("所选时间范围未解码出视频帧".to_owned());
    }
    emit(
        writer,
        &json!({
            "type": "summary", "source": source, "video": video.to_string_lossy(),
            "width": width, "height": height, "from": options.from, "to": options.to,
            "sampleFps": options.fps, "frames": frames, "readingsByStatus": statuses,
            "failureReasons": failures, "jumps": events.len(), "profileReadiness": readiness,
            "meanMsPerFrame": recognition_ms / frames as f64,
            "recognizeFramesPerSecond": if recognition_ms > 0.0 { frames as f64 * 1000.0 / recognition_ms } else { 0.0 },
            "decodeAndRecognizeSeconds": started.elapsed().as_secs_f64(),
            "timebase": "file-relative-sampled"
        }),
    )?;
    Ok(events)
}

fn run(options: Options, writer: &mut impl Write) -> Result<(), String> {
    if options.automatic
        || matches!(
            options.operation,
            Operation::Locate(_) | Operation::Learn { .. }
        )
    {
        return auto::run(&options, writer);
    }
    let profile = fs::read_to_string(options.profile.as_ref().ok_or("缺少 --profile")?)
        .map_err(|error| format!("读取配置失败: {error}"))?;
    match &options.operation {
        Operation::Recognize(video) => {
            recognize_video(&options, &profile, video, "official", writer)?;
        }
        Operation::Offset {
            official,
            commentary,
        } => {
            let official_events =
                recognize_video(&options, &profile, official, "official", writer)?;
            let commentary_events =
                recognize_video(&options, &profile, commentary, "commentary", writer)?;
            let estimate = dispatch(
                "estimateOffset",
                json!({
                    "officialEvents": official_events, "commentaryEvents": commentary_events, "options": {}
                }),
            )?;
            emit(
                writer,
                &json!({"type": "offset", "estimate": estimate, "timebase": "file-relative-sampled"}),
            )?;
        }
        _ => unreachable!("automatic operations dispatched above"),
    }
    Ok(())
}

fn main() {
    let options = parse_options(
        env::args_os().skip(1).collect(),
        env::var_os("STREAM_SYNC_FFMPEG"),
    );
    let result = match options {
        Ok(Some(options)) => run(options, &mut BufWriter::new(io::stdout().lock())),
        Ok(None) => {
            print!("{HELP}");
            Ok(())
        }
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        eprintln!("错误: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn validates_range_and_finite_sample_rate() {
        for extra in [
            vec!["--fps", "NaN"],
            vec!["--fps", "0"],
            vec!["--from", "-1"],
            vec!["--from", "4", "--to", "4"],
        ] {
            let mut values = vec!["recognize", "--profile", "preset.json", "--video", "a.ts"];
            values.extend(extra);
            assert!(parse_options(args(&values), None).is_err());
        }
    }

    #[test]
    fn automatic_and_discovery_options_are_unambiguous() {
        let parsed = parse_options(
            args(&[
                "recognize",
                "--auto",
                "--video",
                "a.ts",
                "--from",
                "2",
                "--duration",
                "8",
            ]),
            None,
        )
        .unwrap()
        .unwrap();
        assert!(parsed.automatic);
        assert!(parsed.profile.is_none());
        assert_eq!(parsed.fps, 60.0);
        assert_eq!(parsed.to, Some(10.0));
        let parsed = parse_options(
            args(&[
                "learn",
                "--video",
                "a.ts",
                "--roi",
                ".1,.2,.3,.4",
                "--out",
                "new.json",
            ]),
            None,
        )
        .unwrap()
        .unwrap();
        assert!(parsed.roi.is_some());
        assert_eq!(parsed.to, Some(30.0));
        for values in [
            vec![
                "recognize",
                "--auto",
                "--video",
                "a.ts",
                "--from",
                "1e308",
                "--duration",
                "1e308",
            ],
            vec![
                "recognize",
                "--auto",
                "--profile",
                "p.json",
                "--video",
                "a.ts",
            ],
            vec!["recognize", "--auto", "--auto", "--video", "a.ts"],
            vec![
                "recognize",
                "--auto",
                "--video",
                "a.ts",
                "--learn-duration",
                "61",
            ],
            vec!["locate", "--video", "a.ts", "--duration", "61"],
            vec![
                "recognize",
                "--auto",
                "--video",
                "a.ts",
                "--to",
                "4",
                "--duration",
                "3",
            ],
        ] {
            assert!(parse_options(args(&values), None).is_err());
        }
    }

    #[test]
    fn preserves_paths_and_ffmpeg_precedence() {
        let values = [
            "recognize",
            "--profile",
            "配置 a.json",
            "--video",
            "录制 a.ts",
            "--ffmpeg",
            "tool folder/ffmpeg.exe",
        ];
        let parsed = parse_options(args(&values), Some("env-ffmpeg".into()))
            .unwrap()
            .unwrap();
        assert_eq!(parsed.profile, Some(PathBuf::from("配置 a.json")));
        assert_eq!(parsed.ffmpeg, PathBuf::from("tool folder/ffmpeg.exe"));
        assert_eq!(parsed.operation, Operation::Recognize("录制 a.ts".into()));
        assert_eq!(
            ffprobe_path(&parsed.ffmpeg),
            PathBuf::from("tool folder/ffprobe.exe")
        );
        let parsed = parse_options(args(&values[..5]), Some("env-ffmpeg".into()))
            .unwrap()
            .unwrap();
        assert_eq!(parsed.ffmpeg, PathBuf::from("env-ffmpeg"));
    }

    #[test]
    fn rejects_duplicate_unknown_and_inapplicable_arguments() {
        for extra in [
            vec!["--fps", "2", "--fps", "3"],
            vec!["--unknown", "1"],
            vec!["--official", "b.ts"],
            vec!["--to"],
        ] {
            let mut values = vec!["recognize", "--profile", "p.json", "--video", "a.ts"];
            values.extend(extra);
            assert!(parse_options(args(&values), None).is_err());
        }
        assert!(parse_options(
            args(&["offset", "--profile", "p.json", "--official", "a.ts"]),
            None
        )
        .is_err());
    }

    #[test]
    fn reads_full_frames_and_rejects_truncation() {
        let mut reader = Cursor::new(vec![1_u8; 9]);
        let mut frame = [0_u8; 4];
        assert!(read_frame(&mut reader, &mut frame).unwrap());
        assert!(read_frame(&mut reader, &mut frame).unwrap());
        assert!(read_frame(&mut reader, &mut frame)
            .unwrap_err()
            .contains("1/4"));
        assert!(!read_frame(&mut Cursor::new(Vec::<u8>::new()), &mut frame).unwrap());
    }

    #[test]
    fn drains_diagnostics_with_bounded_memory() {
        let input = vec![b'x'; 100_000];
        assert_eq!(stderr_tail(Cursor::new(input)).len(), 32 * 1024);
    }

    #[test]
    fn reports_subprocess_failure() {
        // The test harness rejects this switch on all supported host platforms.
        let error = checked_output(
            Command::new(env::current_exe().unwrap()).arg("--invalid-cli-test-option"),
            "测试子进程",
        )
        .unwrap_err();
        assert!(error.contains("测试子进程 失败"));
    }
}
