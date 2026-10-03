// The host-facing view of a device: identity + capabilities + live property values + a stream path for
// cameras. This is the shape the WS `devices.list` / `device.state` / `device.properties` commands and
// the go2rtc camera registration both read, so a camera is "a device describeDevice gave a `stream`",
// not `deviceClass === "camera"` (the SDK downgrades a camera behind a HomeBase to "other").

export function createDeviceView(ctx) {
  const { eufy } = ctx;
  const { streaming } = ctx.state;

  // The SDK keeps handed-out Device objects weakly. propertyChanged is announced
  // against the live Device instance, so a long-lived bridge must keep the devices
  // it exposes strongly reachable for as long as they remain in the account.
  const heldDevices = new Map();

  async function heldDevice(sn) {
    let dev = heldDevices.get(sn);
    if (!dev) {
      dev = await eufy.getDevice(sn);
      heldDevices.set(sn, dev);
    }
    return dev;
  }

  /**
   * Build the host-facing summary of one device: identity + capabilities + a stream path for a camera.
   *
   * `name` is the owner's device name (falling back to the product name when unnamed), `model` is the
   * T-code, `modelName` is the product. A host shows `name` as the device name and `model`/`modelName`
   * as its model — no cross-referencing the device list.
   */
  async function describeDevice(sn) {
    const dev = await heldDevice(sn);
    const m = dev.describe();
    const isCamera = m.capabilities.includes("camera") || m.capabilities.includes("video");
    return {
      sn: m.sn,
      name: m.name, // owner's device name (e.g. "Dining room"), from device_name
      model: m.model || m.modelName, // T-code (e.g. "T8410"); product name as fallback
      modelName: m.modelName, // product display name (e.g. "Indoor Cam Pan & Tilt")
      codec: m.codec,
      capabilities: m.capabilities,
      state: propertyState(dev), // live property values ({ battery: 74, motion: false, … })
      stream: isCamera ? `/stream/${m.sn}` : undefined,
      streaming: isCamera ? streaming.has(m.sn) : undefined, // live P2P feed active right now?
      canReboot: m.codec === "station", // HomeBase-only; drives a Reboot button in HA
    };
  }

  /** Live property values as a flat `{ name: value }` map (reading schedules a background refresh). */
  function propertyState(dev) {
    const out = {};
    for (const [name, pv] of Object.entries(dev.getProperties())) out[name] = pv.value;
    return out;
  }

  /**
   * The device's property manifest — the host-relevant half of each PropertySpec, so a frontend can
   * build the right entity (writable bool → switch, enum → select, number → number, else sensor)
   * without knowing eufy wire ids. Wire-only fields (paramType, decode, aliases) are omitted.
   */
  function propertySpecs(dev) {
    return (dev.properties ?? []).map((p) => ({
      name: p.name,
      type: p.type, // "bool" | "number" | "string" | "enum"
      unit: p.unit, // "%", "°C", "dBm", …
      kind: p.kind, // percent | celsius | dbm | seconds | …
      writable: p.writable, // a setter exists (device.set accepts it)
      enumValues: p.enumValues, // { raw: label } for enums
      description: p.description,
    }));
  }

  async function deviceList() {
    const devices = await eufy.getDevices();

    const present = new Set(devices.map((d) => d.sn));
    for (const sn of heldDevices.keys()) {
      if (!present.has(sn)) heldDevices.delete(sn);
    }

    return Promise.all(
      devices.map((d) => describeDevice(d.sn).catch((e) => ({ sn: d.sn, error: String(e?.message ?? e) }))),
    );
  }

  return { describeDevice, propertyState, propertySpecs, deviceList };
}
