## 4. douyu-quickjs

Status: PASS for live signing and packet-level playback verification. Quality selection is a separate unresolved finding below.

Run from `Stream Syncer Claude`:

```powershell
$env:NODE_USE_ENV_PROXY='1'
node prototype/douyu-quickjs/run.mjs
```

Dependencies: Node 24.15.0, local `quickjs-emscripten@0.32.0`. The ffprobe executable defaults to `<home>\Desktop\ffmpeg\bin\ffprobe.exe`; override with `P0_FFPROBE`. `P0_DOUYU_ROOM` optionally selects a public numeric room ID. No listener is created, no cookies are sent, and no Node `vm` is imported or called. Remote code is evaluated only by QuickJS WASM.

Observed run: 2026-10-18 14:45:34-14:45:40 UTC. Live directory and public room API returned HTTP 200. Room `9999` had `room_status=1`. The mobile page returned HTTP 200 and contained the obfuscated `ub98484234` function. The prototype decodes its returned signing source inside one QuickJS runtime and executes the transformed signing function inside another. Known `rid+did+timestamp+version` MD5 is precomputed in Node and substituted as a literal; no host API or callback is exposed to either sandbox.

Sandbox evidence:

| Check | Observed result |
| --- | --- |
| Memory allocation limit | `16777216` bytes, 16 MiB, per QuickJS runtime |
| Interrupt deadline / stack limit | `500` ms / `524288` bytes |
| Infinite loop | `InternalError: interrupted`, `500.672` ms, `17667` interrupt checks |
| Allocate 32 MiB ArrayBuffer | `InternalError: out of memory`, `0.820` ms |
| process / require / fetch / XMLHttpRequest / WebSocket / console | All six `typeof` values are `undefined` |
| Obfuscated source / decoded source | `19599` / `1800` bytes |
| Decode / sign elapsed | `9.141` / `0.853` ms |
| Signed output | `103` bytes; keys `v,did,tt,sign,ver,rid,rate`; values omitted |

POST `https://m.douyu.com/api/room/ratestream` returned HTTP 200 and `code=0`. Actual playback was checked with:

```text
ffprobe.exe -v error -http_proxy <existing proxy> -rw_timeout 15000000 -read_intervals %+3 -count_packets -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,bit_rate,nb_read_packets:format=format_name,duration -of json <signed returned URL>
```

| Requested rate | API label | Returned rate | Actual video | Actual audio | ffprobe |
| --- | --- | --- | --- | --- | --- |
| -1 | Default | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | Exit 0, 1976.6 ms |
| 0 | 原画2K60 | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | Exit 0, 763.5 ms |
| 3 | 超清 | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | Exit 0, 760.5 ms |
| 2 | 高清 | 0 | H.264, 1280x720, 30/1 fps, 89 packets | AAC, 136 packets | Exit 0, 761.8 ms |

The API advertised three qualities, but all three explicit requests returned `rate=0` and 720p30 media. Neither 2K60 media nor effective quality switching was observed. This is evidence for mobile-endpoint limitations in this room, rather than proof of generally available desktop quality. Bitrate was not supplied by ffprobe for this HLS input and is not inferred.

Problems and fixes: Default Node fetch failed with `EACCES` because it did not use the existing environment proxy. `NODE_USE_ENV_PROXY=1` resolved it. The first ffprobe attempt automatically upgraded the returned HTTP URL to HTTPS, following the reference, and failed in the supplied Schannel build with `Unable to acquire security credentials (0x8009030e)`, exit 1 in 32.4 ms. The fixed prototype preserves the API's original HTTP URL and passed playback plus all three rate probes. It does not disable TLS checks. This validates signed HTTP media transport here, not HTTPS media transport.

Evidence files: `.evidence/douyu-quickjs.json` contains only sanitized commands, API statuses and numbers. `.evidence/douyu-initial-failures.json` preserves the failed attempts and fixes. Remote page, signed params, API response, expiring stream URL and raw ffprobe artifacts are retained only in ignored `.media/douyu/`.

Recommendation: Keep QuickJS as the remote-code boundary, use one fresh runtime per decode/sign phase, apply the 16 MiB allocation cap and interrupt deadline, and dispose every handle/context/runtime. These are QuickJS allocation and instruction-execution limits, not a hard 16 MiB cap on total Node/WASM process memory. Production should execute the sandbox in a dedicated utility process or worker so a pathological call cannot block Electron's UI/main event loop, impose total-process/watchdog bounds, validate remote source shape and classify upstream failures.

Decision inputs: Add a separately verified desktop Douyu quality endpoint or treat unavailable quality switching as a classified limitation; the mobile `ratestream` API's labels cannot be trusted as actual resolution/fps. Preserve or explicitly classify API-returned HTTP transport and test the bundled ffmpeg TLS implementation; do not silently upgrade every URL or disable TLS verification. Existing proxy support should be explicit per platform and confined to the main/utility process.
