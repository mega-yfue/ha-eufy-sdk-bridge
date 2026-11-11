// RECORDINGS_DIR: save every recording a HomeBase 3 lists to a folder, as
// `<RECORDINGS_DIR>/<camera serial>/<YYYYMMDDTHHMMSSZ>.mp4`, named for the UTC time the recording starts.
// Every RECORDINGS_POLL_MS the bridge reads each station's list (today's recordings, see recordings.mjs),
// and downloads each finished recording it has not saved yet. The station lists only its current day, so
// the list is also read just before the station's midnight, and a recording seen once stays queued until
// it is saved, across a day change and a restart (the queue is kept in `.queue.json` in the folder). The
// file is written under a hidden name and renamed when complete, so a reader never sees half a clip. With
// RECORDINGS_OLD_DIR set, a recording older than RECORDINGS_OLD_DAYS moves there (a larger, slower disk).
import fs from "node:fs";
import path from "node:path";
import { muxMp4 } from "./clip.mjs";

const MAX_ATTEMPTS = 3; // a recording whose download fails this many times is given up on
const KEEP_MS = 14 * 86_400_000; // past the station's ~2-week retention: an unsaved recording leaves the queue
const RESCAN_MS = 3_600_000; // how long the set of stations to read is kept before it is found again
const DAY_MS = 86_400_000;
const BEFORE_MIDNIGHT_MS = 30_000; // the last read of a station's day, this long before its midnight

/** `2026-01-01T12:00:00.000Z` → `20260101T120000Z.mp4`. */
export const clipName = (at) => `${at.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z.mp4`;

/** `20260101T120000Z.mp4` → its Date, else undefined. */
export function clipTime(name) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.mp4$/.exec(name);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : undefined;
}

/** A recording's station-local offset from UTC in ms: its local `yyyyMMddHHmmss` name less its UTC start. */
const offsetOf = (rec) => {
  const n = rec.name;
  return (
    Date.UTC(+n.slice(0, 4), +n.slice(4, 6) - 1, +n.slice(6, 8), +n.slice(8, 10), +n.slice(10, 12), +n.slice(12, 14)) -
    rec.start.getTime()
  );
};

/** A queued recording as JSON, and back; undefined for an entry that does not name one. */
const stored = ({ start, end, ...rest }) => ({ ...rest, start: start.toISOString(), end: end?.toISOString() });
const restored = ({ start, end, ...rest }) => {
  const rec = { ...rest, start: new Date(start), end: end ? new Date(end) : undefined };
  const valid =
    typeof rec.deviceSn === "string" &&
    /^[\w-]+$/.test(rec.deviceSn) &&
    /^\d{14}$/.test(rec.name) &&
    !Number.isNaN(rec.start.getTime()) &&
    !Number.isNaN(rec.end?.getTime() ?? 0);
  return valid ? rec : undefined;
};

/** True when `a` is `b` or inside it. */
const within = (a, b) => {
  const rel = path.relative(b, a);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
};

export function createRecordingArchive(ctx) {
  const { cfg, eufy } = ctx;
  const dir = cfg.recordingsDir;
  const log = (...a) => console.log("[bridge:recordings]", ...a);
  const queueFile = dir && path.join(dir, ".queue.json");
  const queued = new Map(); // `${sn}/${name}` -> { rec, attempts }
  const abandoned = new Map(); // keys given up on -> start ms; the station may still list them all day
  const offsets = new Map(); // stationSn -> its last seen local offset from UTC, in ms
  let stations; // { set, at }: the stations with a camera that offers stored recordings
  let sweeping;
  let listing;
  let queueWrites = Promise.resolve();

  /** Where a recording is saved, relative to the folder. */
  const target = (rec) => path.join(rec.deviceSn, clipName(rec.start));
  async function saved(rel) {
    for (const d of [dir, cfg.recordingsOldDir].filter(Boolean)) {
      if (
        await fs.promises.access(path.join(d, rel)).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    return false;
  }

  function loadQueue() {
    try {
      for (const entry of JSON.parse(fs.readFileSync(queueFile, "utf8"))) {
        const rec = entry?.rec && restored(entry.rec);
        if (rec) queued.set(`${rec.deviceSn}/${rec.name}`, { rec, attempts: Number(entry.attempts) || 0 });
      }
    } catch {
      // no queue saved yet, or an unreadable one: today's list fills it again
    }
  }

  /** Write the queue as it stands; writes run one at a time, each taking the queue when it starts. */
  function saveQueue() {
    const write = async () => {
      const entries = [...queued.values()].map(({ rec, attempts }) => ({ rec: stored(rec), attempts }));
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(`${queueFile}.part`, JSON.stringify(entries));
      await fs.promises.rename(`${queueFile}.part`, queueFile);
    };
    const done = queueWrites.then(write, write);
    queueWrites = done.catch(() => {});
    return done;
  }

  /**
   * The stations with at least one camera that offers stored recordings. A complete search is kept for
   * RESCAN_MS, so a sweep with nothing new looks up no device; one that hit an error is not kept.
   */
  async function archiveStations(now = Date.now()) {
    if (stations && now - stations.at < RESCAN_MS) return stations.set;
    const set = new Set();
    let complete = true;
    for (const d of await eufy.getDevices()) {
      const sn = d.sn ?? d.serialNumber;
      const stationSn = d.stationSn ?? d.raw?.station_sn;
      if (!stationSn || set.has(stationSn)) continue;
      try {
        const cam = (await eufy.getDevice(sn)).camera?.();
        if (typeof cam?.downloadRecording === "function") set.add(stationSn);
      } catch (e) {
        complete = false;
        log(`looking up ${sn} failed: ${e?.message ?? e}`);
      }
    }
    stations = complete ? { set, at: now } : undefined;
    return set;
  }

  async function save(rec) {
    const rel = target(rec);
    const file = path.join(dir, rel);
    const part = path.join(path.dirname(file), `.${path.basename(file)}.part`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const found = await ctx.cameraOf(rec.deviceSn);
    if (!found.cam) throw new Error(found.error);
    const clip = await found.cam.downloadRecording({ recording: rec.name, cipherId: rec.cipherId });
    try {
      await (ctx.muxClip ?? muxMp4)(clip, part);
      await fs.promises.rename(part, file);
    } finally {
      await fs.promises.rm(part, { force: true });
    }
    log(`saved ${rel}: ${clip.frames} frames, ${clip.missingFrames} missing, ${clip.durationMs} ms of video`);
  }

  /** Read every station's list and queue each recording not saved yet, then plan the read before midnight. */
  function listAll() {
    listing ??= (async () => {
      for (const stationSn of await archiveStations()) {
        try {
          let newest;
          for (const list of (await ctx.stationRecordings(stationSn)).values())
            for (const rec of list) {
              const key = `${rec.deviceSn}/${rec.name}`;
              if (!rec.start) continue;
              if (!newest || rec.name > newest.name) newest = rec;
              if (queued.has(key) || abandoned.has(key) || (await saved(target(rec)))) continue;
              queued.set(key, { rec, attempts: 0 });
            }
          if (newest) offsets.set(stationSn, offsetOf(newest)); // today's offset, past any DST change
        } catch (e) {
          log(`listing ${stationSn} failed: ${e?.message ?? e}`);
        }
      }
      await saveQueue();
    })().finally(() => {
      listing = undefined;
      planMidnightRead();
    });
    return listing;
  }

  /** One pass: list every station's recordings, then save the finished ones not on disk yet. */
  async function sweep() {
    await listAll();
    const now = Date.now();
    for (const [key, at] of abandoned) if (now - at > KEEP_MS) abandoned.delete(key);
    const due = [...queued.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [key, entry] of due) {
      const { rec } = entry;
      try {
        if (now - rec.start.getTime() > KEEP_MS) {
          queued.delete(key); // the station has overwritten it by now
          continue;
        }
        if (!rec.end || rec.end.getTime() + cfg.recordingsSettleMs > now) continue; // still being written
        if (ctx.state.streaming?.has(rec.deviceSn)) continue; // not while its live view is open
        if (await saved(target(rec))) {
          queued.delete(key);
          continue;
        }
        await save(rec);
        queued.delete(key);
      } catch (e) {
        // A download the SDK refused counts toward giving up. `no-data` is one of those, not final at once:
        // the SDK also answers it when the station sends nothing in time. A local failure (a full disk, a
        // missing mount) is retried until the recording ages out, since the station still holds it.
        if (e?.reason) entry.attempts += 1;
        const gone = entry.attempts >= MAX_ATTEMPTS;
        log(`${key} failed (${e?.reason ?? "error"}): ${e?.message ?? e}${gone ? "; giving up" : "; will retry"}`);
        if (gone) {
          queued.delete(key);
          abandoned.set(key, rec.start.getTime());
        }
      }
    }
    await saveQueue();
  }

  /**
   * Move every saved recording that started more than RECORDINGS_OLD_DAYS ago from RECORDINGS_DIR to
   * RECORDINGS_OLD_DIR, at the same path inside it. Each file is copied under a hidden name, renamed, and
   * only then removed from RECORDINGS_DIR, so it is in one folder or the other at every moment.
   */
  async function moveOld(now = Date.now()) {
    const old = cfg.recordingsOldDir;
    if (!old) return;
    await fs.promises.mkdir(old, { recursive: true });
    const [oldReal, dirReal] = await Promise.all([fs.promises.realpath(old), fs.promises.realpath(dir)]);
    if (within(oldReal, dirReal) || within(dirReal, oldReal)) {
      log("RECORDINGS_OLD_DIR and RECORDINGS_DIR overlap; nothing is moved");
      return;
    }
    const cutoff = now - cfg.recordingsOldDays * DAY_MS;
    const cameras = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const camera of cameras.filter((d) => d.isDirectory())) {
      for (const name of await fs.promises.readdir(path.join(dir, camera.name))) {
        const at = clipTime(name);
        if (!at || at.getTime() >= cutoff) continue;
        const from = path.join(dir, camera.name, name);
        const to = path.join(old, camera.name, name);
        const part = path.join(old, camera.name, `.${name}.part`);
        try {
          await fs.promises.mkdir(path.dirname(to), { recursive: true });
          await fs.promises.copyFile(from, part);
          await fs.promises.rename(part, to);
          await fs.promises.rm(from);
          log(`moved ${camera.name}/${name} to ${old}`);
        } catch (e) {
          await fs.promises.rm(part, { force: true });
          log(`moving ${camera.name}/${name} failed: ${e?.message ?? e}`);
        }
      }
    }
  }

  /** Run a sweep and the move unless they are still going, then plan the read before the next midnight. */
  function tick() {
    sweeping ??= sweep()
      .then(() => moveOld())
      .catch((e) => log(`sweep failed: ${e?.message ?? e}`))
      .finally(() => (sweeping = undefined));
    return sweeping;
  }

  /** When a station's midnight comes before the next poll, read its list once more just before it. */
  function planMidnightRead(now = Date.now()) {
    const { timers } = ctx.state;
    if (timers.recordingsMidnight || !timers.recordings) return;
    const waits = [...offsets.values()].map((offset) => DAY_MS - ((now + offset) % DAY_MS) - BEFORE_MIDNIGHT_MS);
    const wait = Math.min(...waits.filter((w) => w > 0));
    if (!(wait < cfg.recordingsPollMs)) return;
    timers.recordingsMidnight = setTimeout(() => {
      timers.recordingsMidnight = null;
      // The list alone: it must not wait behind downloads still in progress.
      listAll().catch((e) => log(`listing before midnight failed: ${e?.message ?? e}`));
    }, wait);
  }

  /** Start the periodic sweep (once), with a first pass right away. No-op without RECORDINGS_DIR. */
  function startRecordingArchive() {
    if (!dir || ctx.state.timers.recordings) return;
    log(`saving recordings to ${dir} every ${Math.round(cfg.recordingsPollMs / 1000)} s`);
    loadQueue();
    ctx.state.timers.recordings = setInterval(() => void tick(), cfg.recordingsPollMs);
    void tick();
  }

  return { startRecordingArchive, recordingArchiveSweep: tick, moveOldRecordings: moveOld };
}
