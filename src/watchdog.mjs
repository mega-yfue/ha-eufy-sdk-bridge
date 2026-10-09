// FCM push liveness watchdog. Push connect/disconnect is an explicit transport lifecycle signal, so a
// sustained disconnect can be recovered without inferring health from device traffic. The pinned SDK
// exposes no successful-poll signal for unchanged polls; no poll-health state is inferred here.
// Process/container supervision remains external to this watchdog.
import { LoginStatus } from "@mega-yfue/eufy-sdk";

export function createWatchdog(ctx) {
  const { eufy, PUSH_STALL_MS } = ctx;
  const { flags } = ctx.state;

  async function watchdogTick() {
    if (!flags.ready || flags.recovering) return;
    const pushDeadMs = flags.pushConnected ? 0 : Date.now() - flags.pushSince;
    if (pushDeadMs < PUSH_STALL_MS) return;
    flags.recovering = true;
    console.error(`[bridge] realtime stalled (push down ${Math.round(pushDeadMs / 1000)}s) — re-establishing`);
    try {
      await eufy.disconnect();
      const result = await eufy.login();
      await ctx.applyLogin(result);
      if (result.status !== LoginStatus.Ok) {
        console.error(`[bridge] re-login not OK (${result.status}) — exiting for a clean restart`);
        process.exit(1);
      }
      eufy.setPollInterval(eufy.pollIntervalMs);
      flags.pushSince = Date.now();
      console.log("[bridge] realtime re-established after push disconnect");
    } catch (e) {
      console.error(`[bridge] push recovery failed (${e?.message ?? e}) — exiting for a clean restart`);
      process.exit(1);
    } finally {
      flags.recovering = false;
    }
  }

  return { watchdogTick };
}
