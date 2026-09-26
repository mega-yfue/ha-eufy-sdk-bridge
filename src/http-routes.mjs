// HTTP surface: live video (go2rtc pulls /stream/<sn>), a snapshot still, the persisted last-event
// thumbnail, and /healthz. Video is deliberately OFF the WS — connecting to /stream is what opens the
// camera, disconnecting is what stops it, so there's no "is it streaming" flag to drift. Returns the
// request handler; server.mjs wraps it in http.createServer.
import fs from "node:fs";
import path from "node:path";
import { streamClientFor, dropStreamClient } from "../streams.mjs";
import { createLiveStillTap } from "./live-still.mjs";

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

// go2rtc's HTTP API (the fixed `:1984` the generated go2rtc.yaml listens on). Used only to answer
// "who is pulling this stream?": the bridge's `/stream` is always pulled by go2rtc's OWN ffmpeg, so the
// bridge alone can't see the human behind it — go2rtc can (it tracks each WebRTC/RTSP/HLS consumer).
const GO2RTC_API_PORT = Number(process.env.GO2RTC_API_PORT) || 1984;
// Throttle the go2rtc consumer probe per device (a stream can be re-requested on a tight retry loop).
// `0` disables the probe; the immediate-requester line still logs on every request.
const STREAM_CONSUMER_LOG_MS = Number(process.env.BRIDGE_STREAM_CONSUMER_LOG_MS ?? 15000);

export function createHttpHandler(ctx) {
  const { cfg, eufy, SCHEMA_VERSION, eventImageDir } = ctx;
  // Per-camera P2P client for /stream. Production uses the module cache in streams.mjs; ctx may
  // supply its own so the route can be driven without a login (tests).
  const openStreamClient = ctx.streamClientFor ?? streamClientFor;
  const dropClient = ctx.dropStreamClient ?? dropStreamClient;
  const { flags } = ctx.state;
  const { streaming, idleSuspended, activeStreams, lastPullAttempt, rtspLastActive } = ctx.state;

  // Ask go2rtc who is CONSUMING a stream (its remote address / user-agent / protocol) and log each — so
  // a stream that keeps opening "by itself" can be traced to the real viewer (an HA card, a recording,
  // a WebRTC/HLS client) rather than the go2rtc ffmpeg the bridge sees. Best-effort: on any error (go2rtc
  // disabled / not ready) the immediate-requester line already logged is the fallback.
  const lastConsumerLog = new Map(); // sn -> ts of the last probe
  async function logStreamConsumers(sn) {
    try {
      const r = await fetch(`http://127.0.0.1:${GO2RTC_API_PORT}/api/streams?src=${encodeURIComponent(sn)}`);
      if (!r.ok) return;
      const data = await r.json();
      const consumers = (data?.consumers ?? data?.[sn]?.consumers ?? []).filter(Boolean);
      if (!consumers.length) {
        ctx.eventLog?.(
          `/stream ${sn} — go2rtc reports NO consumers (a leftover ffmpeg retry / probe, not a live viewer)`,
        );
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
      const idleSec = Math.round((Date.now() - flags.lastActivity) / 1000);
      return json(res, 200, {
        ok: true,
        schemaVersion: SCHEMA_VERSION,
        auth: ctx.authStatus(),
        sessionLost: flags.sessionLost, // cloud token kicked/expired since boot → re-auth in progress/needed
        streaming: [...streaming],
        idleSuspended: [...idleSuspended], // cameras auto-off for no recent detection (awaiting next one)
        streamIdleMs: cfg.streamIdleMs, // 0 = idle auto-off disabled
        lastActivitySec: idleSec, // seconds since the last poll heartbeat / realtime event
        stalled: flags.ready && idleSec * 1000 >= ctx.stallThresholdMs(),
        pushConnected: flags.pushConnected, // FCM push channel — events (motion/doorbell/…) ride this
        pushIdleSec: flags.pushConnected ? 0 : Math.round((Date.now() - flags.pushSince) / 1000),
      });
    }
    if (!flags.ready) return json(res, 503, { error: "not authenticated", auth: ctx.authStatus() });

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
      if (snapshotMode != null && !["auto", "stored", "live"].includes(snapshotMode)) {
        return json(res, 400, { error: "invalid snapshot mode", mode: snapshotMode });
      }

      // Two pictures can sit on disk: the last event's thumbnail, and the last frame of a stream someone
      // watched (live-still.mjs). Either may be the more recent one, so serve whichever is newer.
      const candidates = [
        { file: path.join(eventImageDir, `last-live-${sn}.jpg`), label: "last live picture" },
        { file: path.join(eventImageDir, `last-event-${sn}.jpg`), label: "last event thumbnail" },
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
      try {
        const device = await eufy.getDevice(sn);
        const cam = device.camera?.();
        if (!cam) return json(res, 404, { error: "no camera on this device" });
        // A battery-capable camera pays a radio wake for every still; one without that capability does not. Same test the idle
        // watcher uses (see stream-idle.mjs), so "which cameras are expensive" is decided in one way.
        const onBattery = (device.describe?.()?.capabilities ?? []).includes("battery");
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
            ({ jpeg } = await cam.snapshotLive());
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
        if (!jpeg) {
          try {
            jpeg = await cam.snapshotStored?.(); // may throw when nothing is retained
          } catch (e) {
            const reason = `nothing retained: ${e?.reason ?? e?.message ?? e}`;
            why = why ? `${why}; ${reason}` : reason;
          }
        }
        if (jpeg) {
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

    if (kind === "stream" && sn) {
      noteStreamRequest(sn, req); // trace who is pulling this stream (incl. go2rtc's real consumers)
      if (cfg.streamIdleMs) lastPullAttempt.set(sn, Date.now()); // consumer is asking (watched vs. gone)
      // Idle-suspended: no detection recently, so don't reopen the P2P session. go2rtc's ffmpeg source
      // retries into this until a detection or the consumer giving up lifts it (see streamIdleTick).
      if (cfg.streamIdleMs && idleSuspended.has(sn))
        return json(res, 503, {
          error: "stream idle-suspended — no recent detection, waiting for motion or a fresh viewer",
        });
      // Failure-backoff: a recent open failed (P2P unreachable), and go2rtc retries every ~30s. Serve a
      // fast 503 without opening a P2P session, so a camera that can't connect isn't woken on every retry.
      const backoff = ctx.streamBackoffMs?.(sn) ?? 0;
      if (backoff > 0)
        return json(res, 503, {
          error: `stream backing off after a failed open — retry in ${Math.ceil(backoff / 1000)}s (P2P unreachable)`,
        });
      try {
        const client = await openStreamClient(sn, cfg); // its OWN P2P session — see streams.mjs
        const cam = (await client.getDevice(sn)).camera?.();
        if (!cam?.openReadable) return json(res, 404, { error: "no live video on this device" });
        // The battery budget only takes effect when this call opens the session, which it does: the stream
        // client is dedicated to /stream (stills go through the control client), so nothing opens it first.
        const budget = cfg.streamBatteryBudgetMs;
        const feed = await cam.openReadable(budget ? { batteryBudgetMs: budget } : undefined); // Annex-B
        ctx.noteStreamOpened?.(sn); // reachable again → clear any failure backoff
        if (!streaming.has(sn)) ctx.broadcast({ event: "streamState", deviceSn: sn, active: true });
        streaming.add(sn);
        activeStreams.set(sn, { feed, startedAt: Date.now() });
        rtspLastActive.set(sn, Date.now()); // a live stream counts as activity for the rtspStream auto-off
        res.writeHead(200, { "content-type": "video/H264", "cache-control": "no-cache" });
        feed.pipe(res);
        // Remember the stream's latest keyframe so the still can show what was last SEEN, not only the
        // last event — without ever waking the camera for it (see live-still.mjs).
        const still = createLiveStillTap({ sn, dir: eventImageDir, log: ctx.eventLog ?? (() => {}) });
        feed.on("data", still.onChunk);
        // streaming.delete returns true only on the first cleanup for this feed → broadcast "off" once.
        const cleanup = () => {
          void still.flush(); // no-op after the first call
          feed.destroy();
          if (streaming.delete(sn)) ctx.broadcast({ event: "streamState", deviceSn: sn, active: false });
          activeStreams.delete(sn);
        };
        req.on("close", cleanup);
        feed.on("error", cleanup);
        feed.on("close", cleanup);
        return;
      } catch (e) {
        ctx.noteStreamFailure?.(sn); // arm backoff so the next go2rtc retry doesn't wake the radio again
        dropClient(sn); // never reuse a session that just failed — see dropStreamClient in streams.mjs
        return json(res, 502, { error: String(e?.message ?? e) });
      }
    }

    return json(res, 404, { error: "not found" });
  };
}
