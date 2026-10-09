// One stream client per camera, also when two requests ask for it at once. The cache used to be filled
// only after login() had resolved, so two first calls for the same camera each built and logged in a
// client of their own; the one cached first was overwritten and never disconnected. A client dropped or
// shut down while its login was still in flight was never disconnected either — and whoever waited on that
// login must not be handed the client being disconnected, nor evict the one that replaced it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { streamClientFor, dropStreamClient, closeStreamClients, isSupersededStreamClient } from "../streams.mjs";

const cfg = {};

/** A fake EufyMega whose login the test settles by hand. */
function factory() {
  const made = [];
  const create = () => {
    const c = new EventEmitter();
    c.disconnects = 0;
    c.login = () => new Promise((resolve, reject) => Object.assign(c, { resolve, reject }));
    c.disconnect = async () => void c.disconnects++;
    made.push(c);
    return c;
  };
  return { made, create };
}

const tick = () => new Promise((r) => setImmediate(r));

// closeStreamClients() refuses new clients for good, so only the tests at the end of this file may call it;
// the others clean up by dropping what they created.
const forget = () => ["CAM1", "CAM2"].forEach((sn) => dropStreamClient(sn));

test("two concurrent first calls share one client and one login", async (t) => {
  t.after(forget);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  assert.equal(made.length, 1, "the second call must join the login already in flight");
  made[0].resolve({ status: "ok" });
  assert.equal(await a, made[0]);
  assert.equal(await b, made[0]);
  assert.equal(await streamClientFor("CAM1", cfg, create), made[0], "cached afterwards");
  assert.equal(made.length, 1);
});

test("a failed login is not cached, and its client is let go", async (t) => {
  t.after(forget);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  made[0].resolve({ status: "captcha" });
  await assert.rejects(a, /could not hydrate session \(captcha\)/);
  await assert.rejects(b, /could not hydrate session/);
  assert.equal(made[0].disconnects, 1);

  const c = streamClientFor("CAM1", cfg, create); // the next attempt starts fresh
  await tick();
  assert.equal(made.length, 2);
  made[1].resolve({ status: "ok" });
  assert.equal(await c, made[1]);
});

test("a login that throws is not cached either", async (t) => {
  t.after(forget);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  made[0].reject(new Error("network down"));
  await assert.rejects(a, /network down/);
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  assert.equal(made.length, 2);
  made[1].resolve({ status: "ok" });
  await b;
});

test("dropping a client while its login is still in flight disconnects it once the login settles", async (t) => {
  t.after(forget);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  assert.equal(dropStreamClient("CAM1"), true);
  const b = streamClientFor("CAM1", cfg, create); // must not reuse the dropped one
  await tick();
  assert.equal(made.length, 2);
  made[0].resolve({ status: "ok" });
  made[1].resolve({ status: "ok" });
  await assert.rejects(a, isSupersededStreamClient);
  await tick();
  assert.equal(made[0].disconnects, 1, "the dropped client is disconnected, not leaked");
  assert.equal(await b, made[1]);
  assert.equal(made[1].disconnects, 0);
});

test("a stale failure does not evict the client that replaced it", async (t) => {
  t.after(forget);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  dropStreamClient("CAM1");
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  made[1].resolve({ status: "ok" });
  await b;
  made[0].reject(new Error("late failure of the dropped login"));
  await assert.rejects(a);
  assert.equal(await streamClientFor("CAM1", cfg, create), made[1], "the replacement stays cached");
  assert.equal(made.length, 2);
});

test("a caller waiting on a login that gets dropped is rejected at once, not handed the dropped client", async (t) => {
  t.after(forget);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  dropStreamClient("CAM1");
  await assert.rejects(a, isSupersededStreamClient); // before the login settles
  made[0].resolve({ status: "ok" });
  await tick();
  assert.equal(made[0].disconnects, 1, "the late login is still cleaned up");
});

for (const outcome of ["succeeds", "fails"]) {
  test(`a replacement survives the dropped login when that one ${outcome} late`, async (t) => {
    t.after(forget);
    const { made, create } = factory();
    const a = streamClientFor("CAM1", cfg, create);
    await tick();
    dropStreamClient("CAM1");
    const b = streamClientFor("CAM1", cfg, create);
    await tick();
    if (outcome === "succeeds") made[0].resolve({ status: "ok" });
    else made[0].reject(new Error("late failure"));
    await assert.rejects(a, isSupersededStreamClient);
    made[1].resolve({ status: "ok" });
    assert.equal(await b, made[1]);
    await tick();
    assert.equal(made[1].disconnects, 0, "the replacement is never disconnected by the old login");
    assert.equal(streamClientFor("CAM1", cfg, create), b, "and stays cached");
    assert.equal(made.length, 2);
  });
}

test("dropping with a stale lease leaves the newer client alone", async (t) => {
  t.after(forget);
  const { made, create } = factory();
  const a = streamClientFor("CAM1", cfg, create);
  await tick();
  made[0].resolve({ status: "ok" });
  await a;
  dropStreamClient("CAM1", a); // the request that held `a` failed
  const b = streamClientFor("CAM1", cfg, create);
  await tick();
  assert.equal(dropStreamClient("CAM1", a), false, "a second failure on the old client drops nothing");
  made[1].resolve({ status: "ok" });
  assert.equal(await b, made[1]);
  assert.equal(made[1].disconnects, 0);
  assert.equal(dropStreamClient("CAM1", b), true, "its own lease still drops it");
});

for (const [kind, disconnect] of [
  ["absent", undefined],
  ["synchronous", () => {}],
  [
    "throwing",
    () => {
      throw new Error("sync boom");
    },
  ],
  [
    "rejecting",
    async () => {
      throw new Error("async boom");
    },
  ],
]) {
  test(`drop and failed login cope with a disconnect() that is ${kind}`, async (t) => {
    t.after(forget);
    const { made, create } = factory();
    const make = () => {
      const c = create();
      if (disconnect) c.disconnect = disconnect;
      else delete c.disconnect;
      return c;
    };
    const a = streamClientFor("CAM1", cfg, make);
    await tick();
    made[0].resolve({ status: "ok" });
    await a;
    assert.equal(dropStreamClient("CAM1", a), true);
    const b = streamClientFor("CAM1", cfg, make);
    await tick();
    made[1].resolve({ status: "captcha" });
    await assert.rejects(b, /could not hydrate session/);
    await tick(); // nothing may surface as an unhandled rejection
  });
}

// closeStreamClients() is final, so everything about shutdown is checked in this one, last test.
test("closeStreamClients retires every client within its bound and refuses new ones afterwards", async () => {
  const { made, create } = factory();
  const hangingDisconnect = () => Object.assign(create(), { disconnect: () => new Promise(() => {}) });
  const ready = streamClientFor("CAM1", cfg, create); // logged in
  const stuck = streamClientFor("CAM2", cfg, hangingDisconnect); // logged in, disconnect never settles
  const late = streamClientFor("CAM3", cfg, create); // login settles after shutdown began
  const hanging = streamClientFor("CAM4", cfg, create); // login never settles
  await tick();
  made[0].resolve({ status: "ok" });
  made[1].resolve({ status: "ok" });
  await ready;
  await stuck;

  const started = Date.now();
  const closing = closeStreamClients(50);
  made[2].resolve({ status: "ok" });
  await closing;
  assert.ok(Date.now() - started < 1000, "a hanging login or disconnect must not hold shutdown open");
  await assert.rejects(late, isSupersededStreamClient);
  await assert.rejects(hanging, isSupersededStreamClient, "waiters are released even if the login never settles");
  assert.deepEqual(
    [made[0].disconnects, made[2].disconnects],
    [1, 1],
    "logged-in and late clients are both disconnected",
  );

  await assert.rejects(streamClientFor("CAM5", cfg, create), isSupersededStreamClient);
  assert.equal(made.length, 4, "nothing new is built that could outlive shutdown");
  assert.equal(dropStreamClient("CAM1"), false, "cache is empty after close");
});
