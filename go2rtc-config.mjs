// Write go2rtc.yaml from the live device list, so a camera appears with nobody editing YAML.
//
// go2rtc (bundled in the image) is the ONLY media-protocol code in this project: it pulls the bridge's
// one HTTP Annex-B feed per camera and turns it into RTSP / WebRTC / MSE / HLS. Each camera becomes a
// go2rtc stream sourced from `ffmpeg:<the bridge's /stream URL>#video=copy` — copy, not transcode, so
// go2rtc only remuxes.
//
// The file contains real serials, so it is gitignored and generated at startup.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "yaml";

// A device that carries live video: a describeDevice() summary with a `stream` path (capabilities
// include camera/video). This matches what HA turns into a camera entity — using deviceClass here
// would miss a camera the SDK downgrades to "other" for sitting behind a HomeBase (not direct P2P).
const isCamera = (d) => Boolean(d.stream);

/** The same video/audio sources for startup YAML and cameras discovered after boot. */
export function cameraStreams(cfg, devices) {
  const streams = new Map();
  for (const d of devices.filter(isCamera)) {
    // A stream id per camera serial; the source is this bridge's own HTTP feed.
    // `#async` makes ffmpeg stamp frames from the wall clock (-use_wallclock_as_timestamps 1 -async 1)
    // instead of trusting the camera's. The eufy feed starts at dts 0 and then jumps, which a consumer
    // reads as a broken stream: Home Assistant aborts with "Timestamp discontinuity detected: last dts =
    // 0, dts = 4219155056" seconds after the picture starts flowing. Re-stamping costs nothing here —
    // the feed is remuxed, not transcoded, and a live view has no timeline to preserve.
    // These indoor models supply raw H.264; probing can mistake it for MPEG audio/TS.
    // Use a named template: inline {input} is interpreted as a go2rtc source replacement.
    const input = ["T8400", "T8410"].includes(d.model) ? "#input=eufy_h264" : "";
    for (const view of d.views ?? [{ id: d.sn, stream: d.stream }]) {
      const base = `http://${cfg.selfHost}:${cfg.port}`;
      const audioPath = view.stream.replace(/^\/stream\//, "/audio/");
      streams.set(view.id, [
        `ffmpeg:${base}${view.stream}#video=copy#async${input}`,
        `${base}${audioPath}`,
        `ffmpeg:${view.id}#audio=opus#raw=eufy_audio_timestamps`,
      ]);
    }
  }
  return streams;
}

async function readConfig(cfg) {
  let text;
  try {
    text = await readFile(cfg.go2rtcConfig, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
  const config = parse(text) ?? {};
  if (typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid saved go2rtc config");
  if (config.streams != null && (typeof config.streams !== "object" || Array.isArray(config.streams))) {
    throw new Error("Invalid saved go2rtc stream registry");
  }
  return config;
}

/** Retain complete source lists, including the scalar format used by older bridge releases. */
export async function configuredStreams(cfg) {
  // go2rtc 1.9.9's dynamic-source API rejects whitespace. The named template expands to the exact
  // filter used by earlier generated files, including for a camera absent from this discovery.
  const normalize = (source) =>
    typeof source === "string"
      ? source.replace(/#raw=-af asetpts=N\/SR\/TB(?=#|$)/g, "#raw=eufy_audio_timestamps")
      : source;
  return new Map(
    Object.entries((await readConfig(cfg)).streams ?? {}).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.map(normalize) : normalize(value),
    ]),
  );
}

/** Persist a discovered source already present in go2rtc without replacing its active runtime entry. */
export async function rememberConfiguredStreams(cfg, streams) {
  const config = await readConfig(cfg);
  const missing = [...streams].filter(([name]) => !Object.hasOwn(config.streams ?? {}, name));
  if (!missing.length) return;
  config.streams = { ...config.streams, ...Object.fromEntries(missing) };
  await writeFile(cfg.go2rtcConfig, stringify(config, { lineWidth: 0 }), "utf8");
}

/** Source names belonging to the SDK's default or numbered optical views of one device. */
export function isDeviceStream(name, sn) {
  return name === sn || (name.startsWith(sn) && /^_view_(0|[1-9]\d*)$/.test(name.slice(sn.length)));
}

/** Only an explicit SDK deviceRemoved event retires a camera; an absent discovery entry does not. */
export async function forgetConfiguredDevice(cfg, sn) {
  const config = await readConfig(cfg);
  const names = Object.keys(config.streams ?? {}).filter((name) => isDeviceStream(name, sn));
  if (!names.length) return;
  for (const name of names) delete config.streams[name];
  await writeFile(cfg.go2rtcConfig, stringify(config, { lineWidth: 0 }), "utf8");
}

export async function writeGo2rtcConfig(cfg, devices) {
  const streams = await configuredStreams(cfg);
  for (const [name, sources] of cameraStreams(cfg, devices)) streams.set(name, sources);
  const lines = [
    "# generated by ha-eufy-sdk-bridge at startup — do not edit (contains real serials)",
    "api:",
    `  listen: ":${cfg.go2rtcApiPort ?? 1984}"`,
    "rtsp:",
    `  listen: ":${cfg.go2rtcRtspPort ?? 8554}"`,
    "webrtc:",
    `  listen: ":${cfg.go2rtcWebrtcPort ?? 8555}"`,
    "ffmpeg:",
    '  eufy_h264: "-analyzeduration 0 -probesize 32768 -f h264 -i {input}"',
    '  eufy_audio_timestamps: "-af asetpts=N/SR/TB"',
  ];
  const yaml = lines.join("\n") + "\n" + stringify({ streams: Object.fromEntries(streams) }, { lineWidth: 0 });
  await mkdir(dirname(cfg.go2rtcConfig), { recursive: true }).catch(() => {});
  await writeFile(cfg.go2rtcConfig, yaml, "utf8");
  return devices.filter(isCamera).map((d) => d.sn);
}
