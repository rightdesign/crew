/**
 * `crew connect`'s no-`--key` path — RFC 8628 device-authorization, the same
 * flow Synthesis already exposes for a browserless CLI sign-in
 * (`POST /auth/device/authorize`, `POST /auth/device/token` —
 * DeviceAuthController/DeviceAuthService in the synthesis repo). A developer
 * who already has workspace access (typically via SSO — see EPIC-015's
 * sibling synthesis tickets for the group->role side of that) can mint a
 * real, membership-scoped ApiKey from the terminal instead of copying one
 * out of the app's API Keys panel by hand.
 *
 * Deliberately its own module rather than folded into connect.ts: both
 * `/auth/device/authorize` and `/auth/device/token` are `@Public()` —
 * unlike every call `connect.ts` makes, neither takes (or has) an API key,
 * so reusing `connect.ts`'s `get`/`post` helpers (which always attach a
 * Bearer header) would be misleading about what's actually authenticating
 * the request.
 */

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Seconds until this deviceCode/userCode pair expires — RFC 8628's `expires_in`. */
  expiresIn: number;
  /** Minimum seconds between polls — RFC 8628's `interval`; grows on `slow_down`, never shrinks. */
  interval: number;
}

export interface DeviceAuthResult {
  apiKey: { id: string; name: string; keyPrefix: string; key: string; createdAt: string };
  workspace: { id: string; slug: string; name: string };
  identity: { id: string; name: string | null; email: string };
}

/** The code expired before anyone approved or denied it. */
export class DeviceAuthExpired extends Error {}
/** A person actively denied the request in the browser. */
export class DeviceAuthDenied extends Error {}

async function deviceFetch<T>(
  baseUrl: string,
  userAgent: string | undefined,
  path: string,
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; error?: string }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api${path}`, {
    method: 'POST',
    headers: {
      // Cloudflare 403s default agents on this host — same reasoning as
      // connect.ts's own get/post.
      'User-Agent': userAgent ?? 'Mozilla/5.0 TablationCrewAgent/1.0',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => undefined);
  if (!res.ok) {
    return { ok: false, status: res.status, error: (data as { error?: string } | undefined)?.error };
  }
  return { ok: true, data: data as T };
}

/** `POST /auth/device/authorize` — starts the handshake. `deviceName` is shown to whoever approves it in the browser. */
export async function authorizeDevice(
  baseUrl: string,
  userAgent: string | undefined,
  deviceName?: string,
): Promise<DeviceAuthorization> {
  const res = await deviceFetch<DeviceAuthorization>(
    baseUrl, userAgent, '/auth/device/authorize', deviceName ? { deviceName } : {},
  );
  if (!res.ok) throw new Error(`device authorize failed: HTTP ${res.status}`);
  return res.data;
}

/**
 * Polls `/auth/device/token` until approved, denied, or expired —
 * `authorization_pending` and `slow_down` are RFC 8628's "keep polling"
 * vocabulary (the latter also means "wait longer": `interval` only ever
 * grows, per ยง3.5, never shrinks back once bumped), `expired_token`/
 * `access_denied` are terminal. `onWaiting` fires once per pending poll —
 * `crew connect` uses it to print a `.` so a person watching the terminal
 * can tell this is still alive, not hung.
 */
export async function pollForDeviceToken(
  baseUrl: string,
  userAgent: string | undefined,
  auth: DeviceAuthorization,
  onWaiting?: () => void,
): Promise<DeviceAuthResult> {
  let interval = auth.interval;
  const deadline = Date.now() + auth.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await deviceFetch<DeviceAuthResult>(
      baseUrl, userAgent, '/auth/device/token', { deviceCode: auth.deviceCode },
    );
    if (res.ok) return res.data;
    switch (res.error) {
      case 'authorization_pending':
        onWaiting?.();
        continue;
      case 'slow_down':
        interval += 5;
        continue;
      case 'expired_token':
        throw new DeviceAuthExpired(
          'The device code expired before it was approved — run `crew connect` again.',
        );
      case 'access_denied':
        throw new DeviceAuthDenied('The sign-in request was denied.');
      default:
        throw new Error(`device token poll failed: HTTP ${res.status} ${res.error ?? ''}`.trim());
    }
  }
  throw new DeviceAuthExpired(
    'The device code expired before it was approved — run `crew connect` again.',
  );
}
