// A stream client must never bring up its own realtime planes. login() starts an FCM push client unless
// autoRealtime is false, eufy delivers push to ONE registration per account, and the newest login wins —
// so a stream client that opts in silently steals the events the CONTROL client forwards to Home
// Assistant. Reproduced live: one /stream open, and motion/person events stopped account-wide.
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../src/config.mjs";
import { streamClientOptions } from "../streams.mjs";

const { cfg } = loadConfig({ EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw", EUFY_COUNTRY: "DE" });

test("stream clients never start realtime (no second push channel)", () => {
  assert.equal(streamClientOptions(cfg).autoRealtime, false);
});

test("stream clients keep the control client's identity and session", () => {
  const opts = streamClientOptions(cfg);
  // A different openudid or session file would be a SECOND login rather than a hydrate — eufy allows
  // one active login per account, so that would kick the control client outright.
  assert.equal(opts.openudid, cfg.openudid);
  assert.equal(opts.email, cfg.email);
  assert.equal(opts.countryCode, cfg.country);
  assert.ok(opts.store, "must hydrate from the shared session store");
});

test("P2P_PUNCH_SPREAD reaches the stream client; a malformed value leaves it off", () => {
  const base = { EUFY_EMAIL: "x@y.z", EUFY_PASSWORD: "pw" };
  const on = loadConfig({ ...base, P2P_PUNCH_SPREAD: "35" });
  assert.equal(streamClientOptions(on.cfg).p2pPunchSpread, 35);
  assert.equal(loadConfig(base).cfg.p2pPunchSpread, undefined);
  assert.equal(loadConfig({ ...base, P2P_PUNCH_SPREAD: "wide" }).cfg.p2pPunchSpread, undefined);
});
