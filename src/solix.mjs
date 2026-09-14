// Optional Anker Solix support — a SEPARATE account/login from the eufy one, on a separate device
// backend (AWS-IoT MQTT), so it is fully independent of the eufy client: enabled only when SOLIX_EMAIL
// + SOLIX_PASSWORD are set, and its failures never affect eufy devices. It logs in, discovers the
// account's Solix devices as capability-driven SolixDevice objects, opens the shared SecureMqtt
// telemetry stream, and forwards devices + live readings to WS clients (events `solixReady` /
// `solixReading` / `solixAuth`; queried via `solix.devices` / `solix.status`).
import { SolixClient, FileSessionStore, SolixMqtt, discoverSolixDevices } from "@mega-yfue/eufy-sdk";

export function createSolix(ctx) {
  const { cfg } = ctx;
  const s = cfg.solix;
  if (!s) return {}; // disabled — no SOLIX_EMAIL/PASSWORD

  const st = ctx.state.solix; // { status, devices: Map<sn,SolixDevice>, client, mqtt }
  st.client = new SolixClient({
    email: s.email,
    password: s.password,
    countryCode: s.country,
    store: new FileSessionStore(s.session),
  });

  /** A WS-facing summary of one Solix device: identity + capabilities + the latest telemetry values. */
  function summarize(dev) {
    const id = dev.identity();
    return {
      source: "solix",
      sn: dev.serial,
      productCode: dev.productCode,
      name: id.name,
      category: id.category,
      capabilities: dev.capabilities,
      firmware: dev.firmware()?.version,
      online: dev.connectivity()?.online ?? null,
      ssid: dev.connectivity()?.ssid ?? null, // the Wi-Fi network the device is on
      rssi: dev.connectivity()?.rssi ?? null,
      values: dev.telemetry(), // decoded channels from the latest reading (empty until one arrives)
    };
  }
  function solixDeviceList() {
    return [...st.devices.values()].map(summarize);
  }
  function solixStatus() {
    return { enabled: true, state: st.status, deviceCount: st.devices.size };
  }

  /** After a successful login: discover devices, open the telemetry stream, forward readings. */
  async function attach() {
    // discoverDevices moved off the wire client into the model layer (transport ⊥ model): the client is
    // now wire-only, and discoverSolixDevices composes its reads into capability-driven SolixDevice models.
    const devices = await discoverSolixDevices(st.client);
    st.devices = new Map(devices.map((d) => [d.serial, d]));
    st.status = "ready";
    console.log(`[bridge] solix ready — ${devices.length} device(s): ${devices.map((d) => `${d.productCode}/${d.serial}`).join(", ") || "none"}`);
    ctx.broadcast({ event: "solixReady", devices: solixDeviceList() });

    // Live telemetry over the shared AWS-IoT broker (same transport the eufy path uses).
    try {
      const { SolixMqtt } = await loadSolixSdk();
      const mqtt = new SolixMqtt({ mqttInfo: await st.client.getUserMqttInfo() });
      st.mqtt = mqtt;
      mqtt.on("error", (e) => console.error(`[bridge] solix mqtt: ${e?.message ?? e}`));
      mqtt.on("reading", (r) => {
        st.devices.get(r.deviceSn)?.applyReading(r);
        ctx.broadcast({ event: "solixReading", deviceSn: r.deviceSn, productCode: r.productCode, values: r.values });
      });
      for (const d of devices) {
        try {
          await mqtt.watch(d.record);
        } catch (e) {
          console.error(`[bridge] solix watch ${d.serial}: ${e?.message ?? e}`);
        }
      }
    } catch (e) {
      // Reads still work without the live stream — don't fail the whole Solix path on an MQTT hiccup.
      console.error(`[bridge] solix telemetry unavailable: ${e?.message ?? e}`);
    }
  }

  /** Log in (independent of eufy). Surfaces 2FA over WS; a stored session makes this a no-op re-login. */
  async function startSolix() {
    if (st.status === "ready" || st.status === "connecting") return;
    st.status = "connecting";
    ctx.broadcast({ event: "solixAuth", state: "connecting" });
    try {
      const { SolixClient, FileSolixSessionStore } = await loadSolixSdk();
      st.client ??= new SolixClient({
        email: s.email,
        password: s.password,
        countryCode: s.country,
        store: new FileSolixSessionStore(s.session),
      });
      const r = await st.client.login();
      if (r.status === "2fa") {
        st.status = "2fa";
        console.log(`[bridge] solix: 2FA required (${r.method}) — submit via WS 'solix.submitCode'`);
        ctx.broadcast({ event: "solixAuth", state: "2fa", method: r.method });
        return;
      }
      await attach();
    } catch (e) {
      st.status = "error";
      console.error(`[bridge] solix start failed: ${e?.message ?? e}`);
      ctx.broadcast({ event: "solixAuth", state: "error", error: String(e?.message ?? e) });
    }
  }

  /** Complete a pending Solix 2FA with the code the account was sent. */
  async function solixSubmitCode(code) {
    if (st.status !== "2fa") throw new Error("no solix 2FA is pending");
    const r = await st.client.submitVerifyCode(String(code ?? ""));
    if (r.status !== "ok") throw new Error(`solix 2FA not accepted (${r.status})`);
    await attach();
  }

  /** Stop the telemetry stream (shutdown). */
  async function stopSolix() {
    try {
      await st.mqtt?.close?.();
    } catch {
      /* best-effort */
    }
  }

  return { startSolix, solixSubmitCode, solixDeviceList, solixStatus, stopSolix };
}
