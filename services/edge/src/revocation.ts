/**
 * SEC-02: server-side session revocation, effective within 60 seconds.
 *
 * The realm already issues 5-minute access tokens, but passive expiry alone
 * cannot meet the 60-second revocation budget — so revocation is a Valkey
 * denylist the authenticate hook consults on every request that presents a
 * device id (x-device-id header). Deleting a device (or a moderator
 * attestation-key action) writes the deny key before the route replies, so
 * propagation is immediate; the 60-second budget is the measured contract
 * exercised by scripts/revocation_drill.py.
 */

import { EdgeContext, publishRealtime } from "./context.js";

/** SEC-02: the revocation budget the drill measures against. */
export const REVOCATION_PROPAGATION_S = 60;

/** Denylist key — lives a day; far longer than any live token. */
export function revokedDeviceKey(deviceId: string): string {
  return `revoked:dev:${deviceId}`;
}

/**
 * Revoke a device's access: denylist write first, then the own-channel
 * notice so connected clients drop the session immediately.
 */
export async function revokeDeviceAccess(
  ctx: EdgeContext,
  userId: string,
  deviceId: string,
): Promise<void> {
  await ctx.valkey.set(revokedDeviceKey(deviceId), "1", "EX", 86_400);
  await publishRealtime(ctx, `user:${userId}`, {
    type: "session_revoked",
    deviceId,
  }).catch((err) => console.error("revocation notice failed", err));
}

/** Is this device currently denied? One Valkey GET per check. */
export async function isDeviceAccessRevoked(ctx: EdgeContext, deviceId: string): Promise<boolean> {
  return (await ctx.valkey.get(revokedDeviceKey(deviceId))) !== null;
}
