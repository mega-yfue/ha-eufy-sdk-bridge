// Answer /audio at once, before a sleeping camera has woken.
//
// go2rtc dials a camera's sources in turn, and its ADTS reader blocks until it reads a header, so an /audio
// response that waits for the camera's first audio frame holds DESCRIBE for every viewer. The RTSP client on
// the other end (Home Assistant's own go2rtc) gives DESCRIBE a fixed 5 s, so a primed /stream (see
// stream-primer.mjs) can still miss it on the audio source: a camera takes 6-20 s to wake, and even a wired
// T8200 took 4.3 s to its first audio byte.
//
// So /audio starts with silence in the camera's own format and keeps it up, in real time, until the live audio
// takes over. go2rtc fixes the codec from the first bytes it reads, so the silence must match what the camera
// will send: the format is taken from the camera's last live ADTS header (kept the way live-still.mjs keeps
// the last keyframe), never assumed. A camera with no kept format starts the old way. The caller ends the
// response when the live audio turns out to differ, so go2rtc reconnects with the real format.
import fs from "node:fs";
import path from "node:path";

/** ADTS sampling-frequency index → Hz (ISO/IEC 14496-3, table 1.18). */
const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Samples per AAC-LC frame. */
const FRAME_SAMPLES = 1024;

/** Where a camera's last live audio format is kept. */
export const lastAudioFormatFile = (dir, sn) => path.join(dir, `last-audio-${sn}.json`);

/**
 * The format an ADTS frame declares, as `{ mpeg2, profile, rateIndex, channels }`, or null when `buf` does not
 * start with an ADTS header. `profile` is the 2-bit field (1 = AAC-LC), `channels` the channel configuration.
 */
export function adtsFormat(buf) {
  if (!buf || buf.length < 7 || buf[0] !== 0xff || (buf[1] & 0xf6) !== 0xf0) return null;
  return {
    mpeg2: (buf[1] >> 3) & 1,
    profile: buf[2] >> 6,
    rateIndex: (buf[2] >> 2) & 0x0f,
    channels: ((buf[2] & 1) << 2) | (buf[3] >> 6),
  };
}

/** Whether two formats from {@link adtsFormat} would decode the same way. */
export const sameAdtsFormat = (a, b) =>
  !!a &&
  !!b &&
  a.mpeg2 === b.mpeg2 &&
  a.profile === b.profile &&
  a.rateIndex === b.rateIndex &&
  a.channels === b.channels;

/** `fmt` for a log line, e.g. "AAC-LC 16 kHz stereo". */
export const describeAdtsFormat = (fmt) =>
  `AAC-LC ${(SAMPLE_RATES[fmt.rateIndex] ?? 0) / 1000} kHz ${fmt.channels === 1 ? "mono" : fmt.channels === 2 ? "stereo" : `${fmt.channels} ch`}`;

/** Whether a silent frame can be built for `fmt`: AAC-LC, a known rate, mono or stereo. */
export const canPrime = (fmt) =>
  !!fmt && fmt.profile === 1 && SAMPLE_RATES[fmt.rateIndex] !== undefined && (fmt.channels === 1 || fmt.channels === 2);

/** A bit writer for the few fields a silent raw_data_block needs. */
function bitWriter() {
  const bits = [];
  return {
    put(value, n) {
      for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1);
    },
    bytes() {
      while (bits.length % 8) bits.push(0);
      const out = Buffer.alloc(bits.length / 8);
      bits.forEach((b, i) => (out[i >> 3] |= b << (7 - (i & 7))));
      return out;
    },
  };
}

/**
 * One ADTS frame of digital silence in `fmt` (see {@link canPrime}). Each channel is an individual_channel_stream
 * with no scale-factor bands (max_sfb 0), so it carries no spectral data and decodes to zeros; mono is one
 * single_channel_element, stereo one channel_pair_element without a common window.
 */
export function silentAdtsFrame(fmt) {
  const w = bitWriter();
  const ics = () => {
    w.put(0, 8); // global_gain
    w.put(0, 1); // ics_reserved_bit
    w.put(0, 2); // window_sequence: ONLY_LONG_SEQUENCE
    w.put(0, 1); // window_shape
    w.put(0, 6); // max_sfb: no bands, so no section, scale-factor or spectral data
    w.put(0, 1); // predictor_data_present
    w.put(0, 1); // pulse_data_present
    w.put(0, 1); // tns_data_present
    w.put(0, 1); // gain_control_data_present
  };
  if (fmt.channels === 1) {
    w.put(0, 3); // ID_SCE
    w.put(0, 4); // element_instance_tag
    ics();
  } else {
    w.put(1, 3); // ID_CPE
    w.put(0, 4); // element_instance_tag
    w.put(0, 1); // common_window
    ics();
    ics();
  }
  w.put(7, 3); // ID_END
  const raw = w.bytes();
  const len = 7 + raw.length;
  const h = Buffer.alloc(7);
  h[0] = 0xff;
  h[1] = 0xf1 | (fmt.mpeg2 << 3); // syncword, ID, layer 0, protection_absent
  h[2] = (fmt.profile << 6) | (fmt.rateIndex << 2) | (fmt.channels >> 2);
  h[3] = ((fmt.channels & 3) << 6) | (len >> 11);
  h[4] = (len >> 3) & 0xff;
  h[5] = ((len & 7) << 5) | 0x1f; // buffer fullness 0x7FF: variable bit rate
  h[6] = 0xfc; // ...and one raw data block per frame
  return Buffer.concat([h, raw]);
}

/** The kept format of a camera, or null when there is none or it cannot be primed. */
export async function loadAudioFormat(dir, sn) {
  if (!dir) return null;
  try {
    const fmt = JSON.parse(await fs.promises.readFile(lastAudioFormatFile(dir, sn), "utf8"));
    return canPrime(fmt) ? fmt : null;
  } catch {
    return null; // no live audio seen here yet — /audio waits for it, as before
  }
}

/** Keep `fmt` as the camera's format. Best effort: a failed write only costs the next cold start. */
export async function saveAudioFormat(dir, sn, fmt) {
  if (!dir || !fmt) return;
  await fs.promises.writeFile(lastAudioFormatFile(dir, sn), JSON.stringify(fmt)).catch(() => {});
}

/** Forget the camera's format, so its next /audio waits for the camera again (and can answer 404). */
export async function forgetAudioFormat(dir, sn) {
  if (!dir) return;
  await fs.promises.rm(lastAudioFormatFile(dir, sn), { force: true }).catch(() => {});
}

/**
 * Write silent frames in `fmt` to `res` at the rate the camera would send audio (one per 1024 samples, 64 ms at
 * 16 kHz) until the returned stop() is called. Paced by the wall clock, not by a timer count, so the samples
 * written match the time that passed: go2rtc's Opus loopback stamps audio by sample count (`asetpts=N/SR/TB`),
 * and a burst would put the live audio behind its video. Writes stop by themselves once the response is gone.
 * The response's headers must already be sent.
 */
export function startAudioPrimer(res, fmt, { now = () => Date.now() } = {}) {
  const frame = silentAdtsFrame(fmt);
  const frameMs = (FRAME_SAMPLES * 1000) / SAMPLE_RATES[fmt.rateIndex];
  const startedAt = now();
  let written = 0;
  const write = () => {
    const due = Math.floor((now() - startedAt) / frameMs) + 1;
    while (written < due && !res.destroyed && !res.writableEnded) {
      res.write(frame);
      written++;
    }
  };
  write();
  const timer = setInterval(write, Math.max(10, Math.floor(frameMs / 2)));
  timer.unref?.();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  res.once?.("close", stop);
  return {
    /** Silent frames written so far. */
    get frames() {
      return written;
    },
    stop,
  };
}
