// Whether a camera runs on battery, decided the way the SDK decides it for its own live-media budget.
// The `battery` capability alone is not enough: some mains-powered models still resolve it (the T8423
// floodlight, for one), and the SDK keeps a list of mains-only models that `cameraPowerTier` applies.
// Every battery-saving rule in the bridge (stream idle-off, rtspStream auto-off, SNAPSHOT_LIVE=auto) asks
// this one question, so they agree on which cameras are expensive to wake.
import { cameraPowerTier } from "@mega-yfue/eufy-sdk";

/** True when the camera is battery-powered; `model` is its T-code, `capabilities` its capability names. */
export function onBatteryPower(model, capabilities) {
  return cameraPowerTier(model, new Set(capabilities ?? [])) === "battery";
}
