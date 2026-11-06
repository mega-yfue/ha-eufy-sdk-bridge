// HTTP surface: live video (go2rtc pulls /stream/<sn>), a snapshot still, the persisted last-event
// thumbnail, the latest detection's stored clip, and /healthz. Video is deliberately OFF the WS — connecting to /stream is what opens the
// camera, disconnecting is what stops it, so there's no "is it streaming" flag to drift. Returns the
// request handler; server.mjs wraps it in http.createServer.
import fs from "node:fs";
import path from "node:path";
import { streamClientFor, dropStreamClient, isSupersededStreamClient } from "../streams.mjs";
import { createLiveStillTap, keyframeCodec, lastLiveKeyframeFile } from "./live-still.mjs";
import { liveFeedOpener } from "./live-feed.mjs";
import { loadPrimer, startPrimer } from "./stream-primer.mjs";
import { PLACEHOLDER_CODEC, PLACEHOLDER_KEYFRAME } from "./stream-placeholder.mjs";
import { onBatteryPower } from "./power.mjs";
import { storedThumbnailSeenAt } from "./stored-thumbnail.mjs";
import { redactSecrets } from "./redact.mjs";
import { cameraViews, cameraView, requestedView } from "./camera-views.mjs";

function json(res, code, body) {
  const s = redactSecrets(JSON.stringify(body));
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

// Throttle the go2rtc consumer probe per device (a stream can be re-requested on a tight retry loop).
// `0` disables the probe; the immediate-requester line still logs on every request.
const STREAM_CONSUMER_LOG_MS = Number(process.env.BRIDGE_STREAM_CONSUMER_LOG_MS ?? 15000);

/** True for the SDK's "the station's P2P session never connected" (StationUnreachableError / session timeout). */
function isUnreachable(e) {
  return (
    e?.name === "StationUnreachableError" || /did not connect within|P2P connect timeout/.test(String(e?.message ?? e))
  );
}

/**
 * The feed's first chunk, with the feed paused so pipe() picks up from the next one. Resolves null when the
 * viewer (`res`) leaves first; rejects when the feed fails or ends before sending anything.
 */
function firstChunk(feed, res) {
  return new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      feed.off("data", onData);
      feed.off("error", onError);
      feed.off("end", onEnd);
      feed.off("close", onEnd);
      res.off("close", onLeft);
      fn(value);
    };
    const onData = (chunk) => {
      feed.pause();
      settle(resolve, chunk);
    };
    const onError = (e) => settle(reject, e);
    const onEnd = () => settle(reject, new Error("the live feed ended before its first frame"));
    const onLeft = () => settle(resolve, null);
    feed.on("error", onError);
    feed.on("end", onEnd);
    feed.on("close", onEnd);
    res.on("close", onLeft);
    if (res.destroyed) return onLeft(); // left while the feed was opening
    feed.on("data", onData);
  });
}

export function createHttpHandler(ctx) {
  const { cfg, eufy, SCHEMA_VERSION, eventImageDir } = ctx;
  // Per-camera P2P client for /stream. Production uses the module cache in streams.mjs; ctx may
  // supply its own so the route can be driven without a login (tests).
  const openStreamClient = ctx.streamClientFor ?? streamClientFor;
  const dropClient = ctx.dropStreamClient ?? dropStreamClient;
  const { flags } = ctx.state;
  const { streaming, idleSuspended, activeStreams, lastPullAttempt, rtspLastActive } = ctx.state;
  // Every /stream request owns its own entry. Requests for one camera overlap briefly when ffmpeg
  // reconnects before the old connection has closed, so each must release only its own; activeStreams
  // keeps showing one live entry per camera (the shape stream-idle.mjs reads) until the last one ends.
  const openFeeds = new Map(); // sn -> Set<{ feed, startedAt, lease, peers }>
  // Requests that waited on one shared login all fail with it, but the camera failed once: a lease
  // arms the failure backoff only the first time.
  const failedLeases = new WeakSet();
  // A failed session is never reused, but it is not dropped under a request still streaming on it:
  // such a lease is dropped once its last feed ends (see cleanup).
  const dropWhenIdle = new WeakSet();

  /** The persisted image when it was written after `since` and differs from `jpeg`, else undefined. */
  async function diskCopyNewerThan(file, since, jpeg) {
    try {
      if ((await fs.promises.stat(file)).mtimeMs <= since) return undefined;
      const disk = await fs.promises.readFile(file);
      return disk.equals(jpeg) ? undefined : disk;
    } catch {
      return undefined; // nothing persisted yet
    }
  }

  // Ask go2rtc who is CONSUMING a stream (its remote address / user-agent / protocol) and log each — so
  // a stream that keeps opening "by itself" can be traced to the real viewer (an HA card, a recording,
  // a WebRTC/HLS client) rather than the go2rtc ffmpeg the bridge sees. Best-effort: on any error (go2rtc
  // disabled / not ready) the immediate-requester line already logged is the fallback.
  const lastConsumerLog = new Map(); // sn -> ts of the last probe
  // go2rtc's HTTP API, which tracks each WebRTC/RTSP/HLS consumer; the bridge's `/stream` is always
  // pulled by go2rtc's OWN ffmpeg, so the bridge alone can't see the human behind it.
  const go2rtcApiPort = cfg?.go2rtcApiPort ?? 1984;
  async function logStreamConsumers(sn) {
    try {
      const r = await fetch(`http://127.0.0.1:${go2rtcApiPort}/api/streams?src=${encodeURIComponent(sn)}`);
      if (!r.ok) return;
      const data = await r.json();
      const consumers = (data?.consumers ?? data?.[sn]?.consumers ?? []).filter(Boolean);
      if (!consumers.length) {
        // go2rtc opens the source before it registers the viewer that asked for it, so a cold start
        // with a real viewer lands here too; only a request that never gains a consumer is a stray.
        ctx.eventLog?.(`/stream ${sn} — go2rtc lists no consumer yet (normal on a cold start)`);
        return;
      }
      for (const c of consumers) {
        const who = c?.remote_addr || c?.remoteAddr || "?";
        const ua = c?.user_agent || c?.userAgent || "";
        const type = c?.type || (Array.isArray(c?.medias) ? c.medias.join(",") : "") || "consumer";
        ctx.eventLog?.(`/stream ${sn} — go2rtc consumer: ${type} from ${who}${ua ? ` (UA: ${ua})` : ""}`);
      }
    } catch {
      /* go2rtc API unreachable — the immediate-requester line is the fallback */
    }
  }

  // How many consumers go2rtc lists for a stream, or null when go2rtc cannot be asked (disabled, not ready).
  async function go2rtcConsumerCount(sn) {
    if (ctx.go2rtcConsumerCount) return ctx.go2rtcConsumerCount(sn); // tests
    try {
      const r = await fetch(`http://127.0.0.1:${go2rtcApiPort}/api/streams?src=${encodeURIComponent(sn)}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return null;
      const data = await r.json();
      return (data?.consumers ?? data?.[sn]?.consumers ?? []).filter(Boolean).length;
    } catch {
      return null;
    }
  }

  // A battery camera's stream reached its budget (see live-feed.mjs): keep it going while someone still
  // watches, up to STREAM_BATTERY_MAX_MS. Not extending lets the SDK stop the stream after its grace.
  async function onStreamBudget(sn, notice, res) {
    if (res.destroyed) return; // this viewer left; another request on the same camera may still extend
    const starts = [...(openFeeds.get(sn) ?? [])].map((e) => e.startedAt);
    const streamedMs = starts.length ? Date.now() - Math.min(...starts) : 0;
    const secs = (ms) => `${Math.round(ms / 1000)}s`;
    if (cfg.streamBatteryMaxMs > 0 && streamedMs >= cfg.streamBatteryMaxMs) {
      ctx.eventLog?.(
        `/stream ${sn} → battery budget not extended: streaming for ${secs(streamedMs)}, the cap is ${secs(cfg.streamBatteryMaxMs)} (STREAM_BATTERY_MAX_MS)`,
      );
      return;
    }
    const consumers = await go2rtcConsumerCount(sn);
    if (consumers === 0) {
      ctx.eventLog?.(`/stream ${sn} → battery budget not extended: go2rtc lists no viewer`);
      return;
    }
    if (res.destroyed) return;
    notice.extend(cfg.streamBatteryBudgetMs); // undefined → another full SDK budget
    ctx.eventLog?.(
      `/stream ${sn} → battery budget extended (${consumers == null ? "viewer unknown — go2rtc not asked" : `${consumers} viewer(s)`}, streaming for ${secs(streamedMs)})`,
    );
  }

  // Log every /stream request's IMMEDIATE requester (IP + UA). Normally that's go2rtc's own ffmpeg on
  // localhost; anything else means something is pulling the bridge feed directly — itself a finding.
  // Then (throttled) ask go2rtc who the real consumer is.
  function noteStreamRequest(sn, req) {
    const ip = req.socket?.remoteAddress ?? "?";
    const ua = req.headers["user-agent"] ?? "";
    ctx.eventLog?.(`/stream ${sn} requested by ${ip}${ua ? ` (UA: ${ua})` : ""}`);
    if (!STREAM_CONSUMER_LOG_MS) return;
    const now = Date.now();
    if (now - (lastConsumerLog.get(sn) ?? 0) < STREAM_CONSUMER_LOG_MS) return;
    lastConsumerLog.set(sn, now);
    void logStreamConsumers(sn);
  }

  return async function handleHttp(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const [, kind, sn] = url.pathname.split("/");

    if (url.pathname === "/healthz") {
      return json(res, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        bridgeId: ctx.bridgeId, // stable per install: the same bridge under another address has the same id
        auth: ctx.authStatus(),
        sessionLost: flags.sessionLost, // cloud token kicked/expired since boot → re-auth in progress/needed
        streaming: [...streaming],
        idleSuspended: [...idleSuspended], // cameras auto-off for no recent detection (awaiting next one)
        streamIdleMs: cfg.streamIdleMs, // 0 = idle auto-off disabled
        pushConnected: flags.pushConnected, // FCM push channel — events (motion/doorbell/…) ride this
        pushIdleSec: flags.pushConnected ? 0 : Math.round((Date.now() - flags.pushSince) / 1000),
      });
    }
    if (!flags.ready) return json(res, 503, { error: "not authenticated", auth: ctx.authStatus() });

    let view = 0;
    if ((kind === "stream" || kind === "snapshot") && sn) {
      try {
        view = requestedView(url.searchParams);
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    const source = cameraView(sn, view);

    // A current still: a fresh live burst, falling back to the retained push thumbnail, and finally to
    // the copy /event-image persisted on disk. That last step matters on accounts whose pushes carry no
    // thumbnail: without it every still is a 502 after a 10-20s wake, and the caller (HA, HomeKit) then
    // falls back to pulling video — waking the camera again for a picture we already have on disk.
    if (kind === "snapshot" && sn) {
      const snapshotModes = url.searchParams.getAll("mode");
      if (snapshotModes.length > 1) {
        return json(res, 400, { error: "snapshot mode must be specified at most once" });
      }
      const snapshotMode = snapshotModes[0] ?? null;
      if (snapshotMode != null && !["auto", "stored", "live", "screen"].includes(snapshotMode)) {
        return json(res, 400, { error: "invalid snapshot mode", mode: snapshotMode });
      }

      // Two pictures can sit on disk: the last event's thumbnail, and the last frame of a stream someone
      // watched (live-still.mjs). Either may be the more recent one, so serve whichever is newer.
      const candidates = [
        { file: path.join(eventImageDir, `last-live-${source.id}.jpg`), label: "last live picture" },
        ...(view === 0
          ? [{ file: path.join(eventImageDir, `last-event-${sn}.jpg`), label: "last event thumbnail" }]
          : []),
      ];
      /** Serve the newest persisted picture. Instant, and it never touches the camera. */
      const servePersisted = async (why) => {
        try {
          const stats = await Promise.all(
            candidates.map((c) =>
              fs.promises.stat(c.file).then(
                (s) => ({ ...c, at: s.mtimeMs }),
                () => null,
              ),
            ),
          );
          const newest = stats.filter(Boolean).sort((a, b) => b.at - a.at)[0];
          if (!newest) return false;
          const cached = await fs.promises.readFile(newest.file);
          ctx.eventLog?.(`/snapshot ${sn} → 200 ${newest.label} (${cached.length}B, from disk; ${why})`);
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": cached.length });
          res.end(cached);
          return true;
        } catch {
          return false;
        }
      };
      // mode=screen: the last picture someone WATCHED (last-live-<sn>.jpg, see /last-screen), never the last
      // event and never a wake. A camera that was never watched falls back to the usual newest-on-disk choice.
      if (snapshotMode === "screen") {
        try {
          const screen = await fs.promises.readFile(candidates[0].file);
          ctx.eventLog?.(`/snapshot ${sn} → 200 last screen (${screen.length}B, from disk; mode=screen)`);
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": screen.length });
          return res.end(screen);
        } catch {
          if (await servePersisted("mode=screen but never watched — newest picture on disk")) return;
          return json(res, 404, { error: "no picture on disk yet", mode: snapshotMode });
        }
      }
      try {
        const device = await eufy.getDevice(sn);
        const cam = device.camera?.();
        if (!cam) return json(res, 404, { error: "no camera on this device" });
        if (!cameraViews(cam).includes(view)) return json(res, 404, { error: "unsupported camera view", view });
        // A battery camera pays a radio wake for every still; a mains one does not. Same test the idle
        // watcher uses (see power.mjs), so "which cameras are expensive" is decided in one way.
        const desc = device.describe?.();
        const onBattery = onBatteryPower(desc?.model, desc?.capabilities);
        let wantLive = cfg.snapshotLive === "auto" ? !onBattery : cfg.snapshotLive;
        switch (snapshotMode) {
          case "live":
            wantLive = true;
            break;
          case "stored":
            wantLive = false;
            break;
          case "auto":
            wantLive = !onBattery;
            break;
        }

        let why = "";
        if (!wantLive) {
          if (snapshotMode === "stored") {
            why = "live burst disabled (mode=stored)";
          } else if (snapshotMode === "auto") {
            why = "live burst disabled by explicit mode=auto for battery-capable camera";
          } else if (cfg.snapshotLive === "auto") {
            why = "battery-capable camera — no live burst (SNAPSHOT_LIVE=auto)";
          } else {
            why = "live burst disabled (SNAPSHOT_LIVE=0)";
          }
        }
        let jpeg;
        if (wantLive) {
          try {
            ({ jpeg } = await cam.snapshotLive(view === 0 ? undefined : { view }));
            if (!jpeg) {
              if (snapshotMode === "live") why = "live burst produced no usable image";
              else if (snapshotMode === "auto") why = "mode=auto live burst produced no usable image";
            }
          } catch (e) {
            why = `live burst failed: ${e?.message ?? e}`;
          }
        } else if (await servePersisted(why)) {
          // No live burst wanted, and the disk copy holds the same picture the retained thumbnail would:
          // answer from it straight away rather than paying a round-trip per fetch — on an account that
          // retains nothing that call costs ~0.85s and never succeeds, and HA re-fetches stills on a timer.
          return;
        }
        if (!jpeg && view === 0) {
          try {
            jpeg = await cam.snapshotStored?.(); // may throw when nothing is retained
          } catch (e) {
            const reason = `nothing retained: ${e?.reason ?? e?.message ?? e}`;
            why = why ? `${why}; ${reason}` : reason;
          }
        }
        if (jpeg) {
          if (view !== 0) {
            await fs.promises.writeFile(candidates[0].file, jpeg).catch(() => {});
          }
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
          return res.end(jpeg);
        }
        if (await servePersisted(why || "no image from the camera")) return;
        return json(res, 404, { error: "no image available", reason: why });
      } catch (e) {
        if (await servePersisted(`snapshot failed: ${e?.message ?? e}`)) return;
        return json(res, 502, { error: String(e?.message ?? e) });
      }
    }

    // The latest detection thumbnail the SDK downloaded + retained (no live capture). The SDK's cache is
    // in-memory (cleared on restart / watchdog recovery), so we also persist each served thumbnail to disk
    // and fall back to it when nothing is retained — the "Last event" image then survives restarts.
    // "Last screen": the last picture someone WATCHED live (kept by live-still.mjs while a stream runs),
    // separate from "Last event" (/event-image). Never wakes the camera. 404 until it was watched once.
    // x-saved-at carries when the picture was taken, so a consumer can show its age.
    if (kind === "last-screen" && sn) {
      const file = path.join(eventImageDir, `last-live-${sn}.jpg`);
      try {
        const [jpeg, st] = await Promise.all([fs.promises.readFile(file), fs.promises.stat(file)]);
        res.writeHead(200, {
          "content-type": "image/jpeg",
          "content-length": jpeg.length,
          "x-saved-at": new Date(st.mtimeMs).toISOString(),
        });
        return res.end(jpeg);
      } catch {
        return json(res, 404, { error: "camera not watched yet — no last screen", deviceSn: sn });
      }
    }

    if (kind === "event-image" && sn) {
      // HA fetches this to render "Last event" (usually right after a detection event). Trace the
      // outcome so a "Last event never updates" report shows whether HA even asked and what it got back.
      const file = path.join(eventImageDir, `last-event-${sn}.jpg`);
      try {
        const cam = (await eufy.getDevice(sn)).camera?.();
        if (!cam?.snapshotStored) {
          ctx.eventLog(`/event-image ${sn} → 404 no camera on device`);
          return json(res, 404, { error: "no camera on this device" });
        }
        const jpeg = await cam.snapshotStored();
        // The retained thumbnail is the newest PUSHED one, not necessarily the newest picture: on a
        // local-storage account the cloud attaches a thumbnail to only some events, and the on-detection
        // HomeBase refresh writes each later event's cover to disk. So when the disk copy was written after
        // this thumbnail first appeared, it is the newer picture: serve it and leave it in place.
        const seenAt = storedThumbnailSeenAt(ctx.state.storedThumbSeen, sn, jpeg);
        const newer = await diskCopyNewerThan(file, seenAt, jpeg);
        if (newer) {
          ctx.eventLog(
            `/event-image ${sn} → 200 local cover (${newer.length}B, from disk; newer than the retained push thumbnail) — Last event served`,
          );
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": newer.length });
          return res.end(newer);
        }
        fs.writeFile(file, jpeg, () => {}); // best-effort persist for restart survival
        ctx.eventLog(`/event-image ${sn} → 200 live thumbnail (${jpeg.length}B) — Last event updated`);
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
        return res.end(jpeg);
      } catch (e) {
        // Nothing retained live — serve the last persisted thumbnail if we have one.
        try {
          const cached = await fs.promises.readFile(file);
          // Include WHY the live cache was empty (not-observed / pending / download-failed / invalid-image)
          // even though we can still serve a disk copy — on a local-storage account this is expected to be
          // "not-observed" (no push thumbnail), and the on-detection local refresh is what advances it.
          ctx.eventLog(
            `/event-image ${sn} → 200 cached thumbnail (${cached.length}B, from disk; live unavailable: ${e?.reason ?? e?.message ?? e}) — Last event served`,
          );
          // Auto-heal: the disk copy can be stale if the on-detection retry gave up before the HomeBase
          // wrote the crop. Re-attempt the local cover in the background (throttled) so this fetch — and
          // HA's periodic image re-pulls — advance "Last event" once the crop lands, without the manual
          // "Refresh Last Event" button. Fire-and-forget: we serve the current copy right now regardless.
          ctx.autoHealEventImage?.(sn);
          res.writeHead(200, { "content-type": "image/jpeg", "content-length": cached.length });
          return res.end(cached);
        } catch {
          // No live and no persisted image. Surface the SDK reason (not-observed / pending /
          // download-failed / invalid-image) so a caller can tell "no event yet" from a failure.
          ctx.eventLog(
            `/event-image ${sn} → 404 no image (reason=${e?.reason ?? e?.message ?? e}) — Last event NOT updated`,
          );
          return json(res, 404, { error: String(e?.message ?? e), reason: e?.reason });
        }
      }
    }

    // The recording a HomeBase 2 stored for this camera's latest detection, as an mp4 (see clip.mjs).
    if (kind === "clip" && sn) {
      const clip = (await ctx.clipFor?.(sn)) ?? { status: 404, error: "clips unavailable" };
      if (!clip.mp4) {
        ctx.eventLog?.(`/clip ${sn} → ${clip.status} ${clip.reason ?? clip.error}`);
        return json(res, clip.status, { error: clip.error, reason: clip.reason });
      }
      res.writeHead(200, { "content-type": "video/mp4", "content-length": clip.mp4.length });
      return res.end(clip.mp4);
    }

    if (kind === "stream" && sn) {
      noteStreamRequest(sn, req); // trace who is pulling this stream (incl. go2rtc's real consumers)
      if (cfg.streamIdleMs) lastPullAttempt.set(sn, Date.now()); // consumer is asking (watched vs. gone)
      // Idle-suspended: no detection recently, so don't reopen the P2P session. go2rtc's ffmpeg source
      // retries into this until a detection or the consumer giving up lifts it (see streamIdleTick).
      if (cfg.streamIdleMs && idleSuspended.has(sn))
        return json(res, 503, {
          error: "stream idle-suspended — no recent detection, waiting for motion or a fresh viewer",
        });
      // Failure-backoff: a recent open failed, and go2rtc retries every ~30s. Serve a
      // fast 503 without opening a P2P session, so a camera that can't connect isn't woken on every retry.
      const backoff = ctx.streamBackoffMs?.(sn) ?? 0;
      if (backoff > 0)
        return json(res, 503, {
          error: `stream backing off after a failed open (${ctx.state.streamBackoff?.get(sn)?.reason ?? "unknown error"}) — retry in ${Math.ceil(backoff / 1000)}s`,
        });
      // The viewer can leave while the session is still opening (login, P2P connect, warm-up). Watch for
      // that from the start: a feed opened for nobody would hold the camera's live source open and report
      // it as streaming until the idle timeout.
      let gone = false;
      const onGone = () => (gone = true);
      res.once("close", onGone);
      // Instant start: answer now with the last live keyframe, repeated until the live feed takes over, so
      // the consumer's RTSP DESCRIBE does not time out while the camera wakes (see stream-primer.mjs).
      // A camera never watched here has no kept keyframe: it starts with the stand-in picture instead. Only
      // where live keyframes are kept — an H.265 camera recovers from the H.264 stand-in through that file.
      // Only the primary view: whether a secondary one exists is known once the camera answers, and that
      // answer must stay a 404 rather than a primed response.
      const instant = cfg.streamInstantStart && view === 0;
      let primer = instant ? await loadPrimer(eventImageDir, sn) : null;
      if (!primer && instant && cfg.streamPlaceholder && eventImageDir)
        primer = { au: PLACEHOLDER_KEYFRAME, codec: PLACEHOLDER_CODEC, placeholder: true };
      let stopPrimer;
      if (primer && !gone) {
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-cache" });
        stopPrimer = startPrimer(res, primer.au, { intervalMs: cfg.streamPrimerMs });
        ctx.eventLog?.(
          `/stream ${sn} → answered at once with ${primer.placeholder ? "a stand-in picture (no live picture kept yet)" : "the last live picture"} (${primer.au.length}B, ${primer.codec}) while the camera wakes`,
        );
      }
      // An answer once the stream is primed can no longer be a status code: end the response instead, so
      // ffmpeg sees the stream end and go2rtc reconnects.
      const fail = (code, body) => {
        stopPrimer?.();
        res.off("close", onGone);
        if (res.headersSent) res.destroy();
        else json(res, code, body);
      };
      // Never reuse a session that just failed (see dropStreamClient in streams.mjs) — but don't pull it
      // from under another request still streaming on it; drop it when that one ends.
      const dropFailed = (lease) => {
        if (lease && [...(openFeeds.get(sn) ?? [])].some((other) => other.lease === lease)) dropWhenIdle.add(lease);
        else dropClient(sn, lease);
      };
      const attempts = Math.max(1, cfg.streamOpenAttempts ?? 1);
      // A primed request keeps its consumer fed, so it can afford to wait for a camera that takes a minute
      // to wake (4G): it keeps retrying until the open budget is spent, not only `attempts` times. Giving up
      // earlier would arm the failure backoff and refuse the consumer's reconnects while the camera is up.
      const openStartedAt = Date.now();
      const openUntil = openStartedAt + (cfg.streamOpenBudgetMs ?? 0);
      const mayRetry = (attempt) => attempt < attempts || (stopPrimer && Date.now() < openUntil);
      for (let attempt = 1; ; attempt++) {
        let lease;
        let feed;
        const attemptStartedAt = Date.now();
        try {
          lease = openStreamClient(sn, cfg); // its OWN P2P session — see streams.mjs
          const client = await lease;
          const dev = await client.getDevice(sn);
          // `battery` decides whether the idle sweep may auto-off this feed: a mains camera costs nothing to
          // keep streaming, so a continuous consumer (an NVR, say) must not lose it. Unknown → battery.
          // Only a battery stream has a budget to extend, so only it asks to hear about one.
          const desc = dev.describe?.();
          const battery = desc ? onBatteryPower(desc.model, desc.capabilities) : true;
          const cam = dev.camera?.();
          const openFeed = liveFeedOpener(
            cam,
            battery ? { onBudget: (notice) => void onStreamBudget(sn, notice, res) } : undefined,
          );
          if (!openFeed) return fail(404, { error: "no live video on this device" });
          if (!cameraViews(cam).includes(view)) return fail(404, { error: "unsupported camera view", view });
          if (gone) return stopPrimer?.(); // don't wake the camera for a viewer that already left
          // The battery budget only takes effect when this call opens the session, which it does: the stream
          // client is dedicated to /stream (stills go through the control client), so nothing opens it first.
          const budget = cfg.streamBatteryBudgetMs;
          const opts = { ...(budget ? { batteryBudgetMs: budget } : {}), ...(view === 0 ? {} : { view }) };
          feed = await openFeed(Object.keys(opts).length ? opts : undefined); // Annex-B
          // An open feed is not a live one yet: on a reused session whose camera went back to sleep, the start
          // command can go unanswered for 20 s and then fail. Keep the primer going until the first live bytes,
          // and treat a feed that dies before them like a failed open (retried below).
          const first = await firstChunk(feed, res);
          stopPrimer?.();
          res.off("close", onGone);
          if (gone || !first) {
            feed.destroy(); // detaches from the shared live source, so it can stop
            return;
          }
          // The stand-in picture is H.264, and the consumer's ffmpeg fixed its codec on it: an H.265 camera
          // cannot follow in this response. Keep its keyframe and end the response; go2rtc reconnects at once,
          // is primed with the right codec, and joins the still-warm stream (the source lingers a few seconds).
          const liveCodec = keyframeCodec(first);
          if (primer?.placeholder && liveCodec && liveCodec !== PLACEHOLDER_CODEC) {
            if (eventImageDir)
              await fs.promises.writeFile(lastLiveKeyframeFile(eventImageDir, source.id), first).catch(() => {});
            ctx.eventLog?.(
              `/stream ${sn} → live video is ${liveCodec}, not the stand-in's ${PLACEHOLDER_CODEC} — reconnecting with it`,
            );
            feed.destroy();
            res.destroy();
            return;
          }
          ctx.noteStreamOpened?.(sn); // reachable again → clear any failure backoff
          let feeds = openFeeds.get(sn);
          if (!feeds) openFeeds.set(sn, (feeds = new Set()));
          // `peers` lets the idle sweep close every open request for this camera, not only this one.
          const entry = { feed, startedAt: Date.now(), lease, peers: feeds, battery };
          feeds.add(entry);
          if (!streaming.has(sn)) ctx.broadcast({ event: "streamState", deviceSn: sn, active: true });
          streaming.add(sn);
          activeStreams.set(sn, entry);
          rtspLastActive.set(sn, Date.now()); // a live stream counts as activity for the rtspStream auto-off
          if (!res.headersSent)
            res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-cache" });
          res.write(first);
          feed.pipe(res);
          // Remember the stream's latest keyframe so the still can show what was last SEEN, not only the
          // last event — without ever waking the camera for it (see live-still.mjs).
          const still = createLiveStillTap({
            sn: source.id,
            dir: eventImageDir,
            log: ctx.eventLog ?? (() => {}),
            onSaved: view === 0 ? () => ctx.broadcast?.({ event: "lastScreenUpdated", deviceSn: sn }) : undefined,
          });
          still.onChunk(first);
          feed.on("data", still.onChunk);
          let cleanedUp = false;
          const cleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            void still.flush();
            feed.destroy();
            // pipe() ends the response only on a clean end. A feed that failed (P2P drop, warm-up timeout) or
            // closed early would leave ffmpeg on an open, silent socket until its own timeout — abort the
            // response instead, so go2rtc reconnects right away.
            if (!feed.readableEnded) res.destroy();
            feeds.delete(entry);
            if (dropWhenIdle.has(lease) && ![...feeds].some((other) => other.lease === lease)) {
              dropWhenIdle.delete(lease);
              dropClient(sn, lease); // the open that failed on this client earlier — now nobody uses it
            }
            if (activeStreams.get(sn) === entry) {
              const other = feeds.values().next().value; // an overlapping request still streaming this camera
              if (other) activeStreams.set(sn, other);
              else activeStreams.delete(sn);
            }
            if (feeds.size) return;
            openFeeds.delete(sn);
            if (streaming.delete(sn)) ctx.broadcast({ event: "streamState", deviceSn: sn, active: false });
          };
          req.on("close", cleanup);
          feed.on("error", cleanup);
          feed.on("close", cleanup);
          return;
        } catch (e) {
          feed?.destroy();
          // Our client was dropped (or the bridge is shutting down) before its login finished: nothing was
          // opened and the camera did not fail, so neither arm the backoff nor drop the client that replaced it.
          if (isSupersededStreamClient(e)) return fail(503, { error: String(e?.message ?? e) });
          const reason = String(e?.message ?? e);
          // A failed attempt has usually woken a sleeping camera (it answers the cloud lookup only once it is
          // up), so try again at once — on a fresh session — before failing the request.
          // A session the camera has not answered yet. On 4G that is the normal wake: the camera is up after a
          // few seconds, but the cloud goes on handing out its address from before it slept for another ~30 s,
          // and the SDK gives each session 15 s to connect. It is waiting, not failing: say so, and start the
          // next session right away (this one has already closed itself).
          const waking = stopPrimer && isUnreachable(e);
          if (mayRetry(attempt) && !gone) {
            const of = attempt < attempts ? `${attempt}/${attempts}` : `${attempt}, primed`;
            if (waking) {
              const secs = Math.round((Date.now() - openStartedAt) / 1000);
              ctx.eventLog?.(
                `/stream ${sn} → camera not reachable yet after ${secs}s (attempt ${of}) — still waiting for it`,
              );
            } else ctx.eventLog?.(`/stream ${sn} → open attempt ${of} failed (${reason}) — trying again`);
            dropFailed(lease);
            // Past the attempts, pause between tries: a failure that comes back at once (cloud error) would
            // otherwise spin for the whole budget. One that took longer (a session that waited its 15 s) has
            // paused already.
            const rest = (cfg.streamOpenRetryPauseMs ?? 1000) - (Date.now() - attemptStartedAt);
            if (attempt >= attempts && rest > 0) await new Promise((r) => setTimeout(r, rest));
            continue;
          }
          // Arm backoff so the next go2rtc retry doesn't wake the radio again — once per lease.
          if (!lease || !failedLeases.has(lease)) {
            if (lease) failedLeases.add(lease);
            ctx.noteStreamFailure?.(sn, reason);
          }
          dropFailed(lease);
          return fail(502, { error: reason });
        }
      }
    }

    return json(res, 404, { error: "not found" });
  };
}
