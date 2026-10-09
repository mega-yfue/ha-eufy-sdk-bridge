// Auth + session lifecycle, driven over the WS. If eufy demands 2FA/captcha the bridge does NOT exit —
// it surfaces the need and lets the frontend answer. A cloud token kicked/expired AFTER boot is treated
// as a first-class state (`reauth`) so HA stops trusting stale poll data, and re-login is attempted in
// place. Reads cross-module functions (broadcast, completeBoot) off `ctx` at call time.
import { LoginStatus } from "@mega-yfue/eufy-sdk";

export function createAuth(ctx) {
  const { eufy } = ctx;
  const { flags } = ctx.state;

  /** The normalized auth state a frontend reads — one shape for auth.status, the `auth` event and /healthz. */
  function authStatus() {
    // A post-boot session loss outranks `ready`: surface the re-auth need so HA stops trusting stale state.
    if (flags.sessionLost) {
      if (flags.lastLogin?.status === LoginStatus.Captcha) {
        return { state: "require_captcha", image: flags.lastLogin.image, retry: flags.lastLogin.retry };
      }
      if (flags.lastLogin?.status === LoginStatus.TwoFactor) {
        return { state: "require_2fa", method: flags.lastLogin.method };
      }
      return { state: "reauth" }; // kicked; automatic re-login in progress or just failed
    }
    if (flags.ready) return { state: "ok" };
    if (flags.lastLogin?.status === LoginStatus.Captcha) {
      return { state: "require_captcha", image: flags.lastLogin.image, retry: flags.lastLogin.retry };
    }
    if (flags.lastLogin?.status === LoginStatus.TwoFactor) {
      return { state: "require_2fa", method: flags.lastLogin.method };
    }
    return { state: "pending" };
  }

  /** Apply a LoginResult: complete the boot on success, and always tell every client the new auth state. */
  async function applyLogin(result) {
    flags.lastLogin = result;
    if (result.status === LoginStatus.Ok) {
      eufy.forgetDevices?.(); // a fresh session rebinds command sinks: rebuild devices on next use
      await ctx.completeBoot(); // no-op once `ready` (first boot only), so re-auth never re-wires listeners
      if (flags.sessionLost) {
        // Recovered from a post-boot expiry: clear the flag and re-arm the poll under the fresh epoch.
        flags.sessionLost = false;
        eufy.setPollInterval(eufy.pollIntervalMs);
        flags.pushSince = Date.now();
      }
    }
    ctx.broadcast({ event: "auth", ...authStatus() });
  }

  /** Guarded entry: kick off a single re-auth after a post-boot session loss. */
  function maybeRecoverSession() {
    if (flags.ready && !flags.sessionLost && !flags.recovering) void onSessionExpired();
  }

  /**
   * The cloud token was kicked/invalidated after boot. Surface the loss to HA at once (so it stops
   * trusting stale poll data), then try to re-login in place. A fresh login usually needs 2FA — that is
   * broadcast as `require_2fa`, so HA can drive the re-auth immediately.
   */
  async function onSessionExpired() {
    flags.sessionLost = true;
    flags.recovering = true; // also blocks push recovery from racing this
    ctx.broadcast({ event: "auth", ...authStatus() });
    console.error("[bridge] cloud session expired (kicked/invalid) — re-authenticating");
    try {
      await eufy.disconnect().catch(() => {});
      await applyLogin(await eufy.login()); // Ok → clears sessionLost + re-arms; else → surfaces require_2fa
      if (flags.sessionLost)
        console.error(`[bridge] re-login needs user action (${flags.lastLogin?.status}) — drive auth.submit`);
      else console.log("[bridge] cloud session re-established after expiry");
    } catch (err) {
      ctx.broadcast({ event: "auth", ...authStatus() });
      console.error(`[bridge] session recovery failed: ${err?.message ?? err}`);
    } finally {
      flags.recovering = false;
    }
  }

  return { authStatus, applyLogin, maybeRecoverSession, onSessionExpired };
}
