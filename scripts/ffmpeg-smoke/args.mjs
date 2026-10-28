import path from 'node:path';

// Frozen buildFfmpegArgs/hlsOutput subset from Fy1Sync 944ba97. No TLS override.
export function buildArgs(input, directory, runId, audioInput = 'pipe:3', forceFmp4 = false) {
  const dir = directory.replace(/\\/g, '/');
  const fmp4 = Boolean(input.adaptive || forceFmp4);
  const output = ['-c', 'copy', '-sn', '-dn',
    ...(fmp4 ? ['-bsf:a', 'aac_adtstoasc'] : []),
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '8192',
    '-hls_flags', 'temp_file+program_date_time+omit_endlist',
    ...(fmp4 ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', `init_${runId}.mp4`] : []),
    '-hls_segment_filename', path.posix.join(dir, `segment_${runId}_%09d.${fmp4 ? 'm4s' : 'ts'}`),
    path.posix.join(dir, `raw_${runId}.m3u8`)];
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (input.adaptive) return [...base,
    '-protocol_whitelist', 'pipe', '-thread_queue_size', '512',
    '-analyzeduration', '1000000', '-probesize', '1048576',
    '-f', input.adaptive.videoContainer === 'webm' ? 'matroska' : 'mov', '-i', 'pipe:0',
    '-protocol_whitelist', 'file', '-thread_queue_size', '512',
    '-analyzeduration', '1000000', '-probesize', '1048576', '-f', 'mov', '-i', audioInput,
    '-map', '0:v:0', '-map', '1:a:0', ...output];
  return [...base, '-protocol_whitelist', 'http,https,tcp,tls,crypto,httpproxy',
    '-rw_timeout', '20000000', '-i', input.url, '-map', '0:v:0?', '-map', '0:a:0?', ...output];
}
