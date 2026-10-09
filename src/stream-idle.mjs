import { onBatteryPower } from "./power.mjs";

// Battery-saving stream lifecycle. Keep a BATTERY camera's P2P live feed only while it's worth streaming: if no
// detection arrives for cfg.streamIdleMs, tear the feed down AND suspend reopening (go2rtc's ffmpeg
// source then retries into a 503). The suspension lifts on the next detection OR once the consumer stops
// pulling — so a stuck 24/7 consumer keeps the radio off while a viewer that returns is served at once.
// Separately, turn a BATTERY camera's native `rtspStream` publish OFF when it's been idle, since that
// publishes continuously and flattens the battery even when nobody consumes it.

export function createStreamIdle(ctx) {
  const { cfg, eufy, SUSPEND_RELEASE_MS, STREAM_FAIL_BACKOFF_MAX_MS } = ctx;
  const { flags } = ctx.state;
  const { lastDetect, activeStreams, idleSuspended, lastPullAttempt, rtspLastActive, streamBackoff } = ctx.state;

  /** Record a detection and lift any idle-suspension / failure-backoff so the stream may reopen at once. */
  function noteDetection(sn) {
    if (!sn) return;
    const now = Date.now();
    lastDetect.set(sn, now);
    rtspLastActive.set(sn, now); // a detection counts as activity for the battery rtspStream auto-off
    if (idleSuspended.delete(sn)) console.log(`[bridge] stream(${sn}) idle-suspension lifted by detection`);
    streamBackoff.delete(sn); // a live detection means the camera is reachable — let the next pull try
  }

  /**
   * Remaining failure-backoff (ms) for a camera whose recent /stream open failed, else 0. go2rtc's ffmpeg
   * source retries a failed stream every ~30s, and each open wakes the P2P radio — so on a camera that
   * can't connect (P2P timeout, no p2p_did), the idle-suspension guard never engages (the feed never
   * becomes "active") and every retry drains the battery. This backs the reopen off instead, so a
   * hammering consumer gets a fast 503 without a radio wake. 0 (or `streamFailBackoffMs=0`) = no backoff.
   */
  function streamBackoffMs(sn) {
    if (!cfg.streamFailBackoffMs) return 0;
    const b = streamBackoff.get(sn);
    if (!b) return 0;
    const remaining = b.until - Date.now();
    // Window elapsed → allow one attempt, but KEEP the entry so its streak keeps doubling if the next
    // open fails again. It's cleared for good by a successful open or a detection (noteStreamOpened /
    // noteDetection), so a camera that recovers doesn't carry stale backoff.
    return remaining > 0 ? remaining : 0;
  }

  /** Record a failed /stream open and arm exponential backoff (base doubles per streak, capped). */
  function noteStreamFailure(sn) {
    if (!sn || !cfg.streamFailBackoffMs) return;
    const streak = (streamBackoff.get(sn)?.streak ?? 0) + 1;
    const window = Math.min(cfg.streamFailBackoffMs * 2 ** (streak - 1), STREAM_FAIL_BACKOFF_MAX_MS);
    streamBackoff.set(sn, { until: Date.now() + window, streak });
    console.log(
      `[bridge] stream(${sn}) open failed (#${streak}) — backing off reopen ${Math.round(window / 1000)}s (P2P unreachable)`,
    );
  }

  /** A stream opened successfully → the camera is reachable, clear any failure backoff. */
  function noteStreamOpened(sn) {
    if (sn) streamBackoff.delete(sn);
  }

  /**
   * Battery-saver sweep: turn the device's native `rtspStream` publish OFF on a BATTERY camera that has
   * been idle (no detection, no active bridge stream) for cfg.rtspIdleOffMs. Uses cached state (no cloud call).
   */
  async function rtspIdleSweep() {
    if (!cfg.rtspIdleOffMs || !flags.ready || flags.recovering) return;
    const now = Date.now();
    let devices;
    try {
      devices = await ctx.deviceList();
    } catch {
      return;
    }
    for (const d of devices) {
      const sn = d.sn;
      if (!onBatteryPower(d.model, d.capabilities)) continue; // battery cameras only
      if (d.state?.rtspStream !== true) continue; // only if currently publishing
      if (activeStreams.has(sn)) {
        rtspLastActive.set(sn, now);
        continue;
      } // being streamed = active
      const lastSeen = rtspLastActive.get(sn);
      if (lastSeen === undefined) {
        rtspLastActive.set(sn, now);
        continue;
      } // give a full window from first sight
      if (now - lastSeen < cfg.rtspIdleOffMs) continue;
      console.log(
        `[bridge] ${sn} battery + rtspStream idle ${Math.round((now - lastSeen) / 1000)}s — turning rtspStream OFF (battery-save)`,
      );
      try {
        await eufy.setProperty(sn, "rtspStream", false);
        rtspLastActive.set(sn, now); // reset so we don't re-fire before the state refreshes
      } catch (e) {
        console.error(`[bridge] ${sn} rtspStream auto-off failed: ${e?.message ?? e}`);
      }
    }
  }

  /** Periodic sweep: auto-off any active feed whose last detection (or open, whichever is later) is stale. */
  function streamIdleTick() {
    if (!cfg.streamIdleMs) return;
    const now = Date.now();
    // Auto-off any actively-pulled BATTERY feed that has seen no detection for the whole idle window. A
    // mains camera is left streaming: keeping it up costs no battery, and a continuous consumer (an NVR)
    // would otherwise be cut off and held off by the suspension until the next motion.
    for (const [sn, st] of activeStreams) {
      if (st.battery === false) continue;
      const lastSeen = Math.max(st.startedAt, lastDetect.get(sn) ?? 0);
      if (now - lastSeen >= cfg.streamIdleMs) {
        console.log(`[bridge] stream(${sn}) idle ${Math.round((now - lastSeen) / 1000)}s (no detection) — auto-off`);
        idleSuspended.add(sn);
        lastPullAttempt.set(sn, now); // it was being pulled right now; start the "consumer gave up" clock fresh
        // Close every open request for this camera, not only the one activeStreams shows: when ffmpeg's
        // reconnect overlapped two, the other would keep streaming into the suspension. Each destroy fires
        // that feed's cleanup, which drops it from activeStreams/streaming.
        for (const entry of [...(st.peers ?? [st])]) entry.feed.destroy();
      }
    }
    // Lift a suspension once the consumer stops asking: go2rtc only pulls /stream while HA has a viewer,
    // so no pull for SUSPEND_RELEASE_MS means nobody's watching — let the next genuine open succeed
    // without waiting for motion. A stuck consumer (recording / always-on card) keeps pulling into the
    // 503, so it stays suspended and the camera's radio stays off.
    for (const sn of idleSuspended) {
      if (now - (lastPullAttempt.get(sn) ?? 0) >= SUSPEND_RELEASE_MS) {
        idleSuspended.delete(sn);
        console.log(`[bridge] stream(${sn}) idle-suspension lifted — consumer stopped pulling`);
      }
    }
  }

  return { noteDetection, streamIdleTick, rtspIdleSweep, streamBackoffMs, noteStreamFailure, noteStreamOpened };
}
