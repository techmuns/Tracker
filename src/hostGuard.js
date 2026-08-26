// ── Munshot host-session guards ──────────────────────────────────────────
// The tracker runs inside an iframe on the Munshot site, and the host pushes
// the signed-in user's JWT to us over postMessage via the Munshot Dashboard
// SDK. A token arriving that way is only trustworthy because of WHERE IT CAME
// FROM: MessageEvent.origin is set by the browser and cannot be forged by the
// sender's payload, but any page holding a handle on our window can post to
// us. The origin allow-list below is therefore the entire trust boundary.
//
// isTrustedOrigin and isValidSessionPayload are deliberately self-contained —
// no imports, no closure over module scope — because index.js injects them
// into the browser bundle with Function.prototype.toString(). One definition,
// unit-tested here, running in both places.

export const DEFAULT_ALLOWED_HOST_ORIGINS = ['https://chat.muns.io'];

// Env override with a hardcoded fallback, so a deploy that forgets the var
// still ships a real allow-list. An empty list must be impossible: the SDK
// treats allowedOrigins:[] as "not provided" and then, with
// lockOriginOnFirstMessage, accepts the FIRST message from ANY origin and pins
// itself to that sender. Empty fails open, not closed.
export function resolveAllowedOrigins(raw) {
  const parsed = String(raw == null ? '' : raw)
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_ALLOWED_HOST_ORIGINS.slice();
}

// Exact scheme+host+port match only. No wildcards, no subdomain matching, no
// paths — 'https://chat.muns.io.evil.example' and 'http://chat.muns.io' must
// both fail, and so must an empty allow-list.
export function isTrustedOrigin(origin, allowed) {
  if (!origin || typeof origin !== 'string') return false;
  if (!Array.isArray(allowed) || allowed.length === 0) return false;
  return allowed.indexOf(origin) !== -1;
}

// Structural check on the session a host message claims to carry. Not email
// validation for its own sake — it stops a malformed or hostile payload
// smuggling a non-string into fields the app puts into headers or renders.
export function isValidSessionPayload(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return false;
  const email = session.email;
  if (email !== null && email !== undefined) {
    if (typeof email !== 'string') return false;
    if (email.length === 0 || email.length > 320) return false; // RFC 5321 bound
    if (email.indexOf('@') === -1) return false;
  }
  const keys = ['token', 'userName', 'orgId', 'orgName'];
  for (let i = 0; i < keys.length; i++) {
    const v = session[keys[i]];
    if (v !== null && v !== undefined && typeof v !== 'string') return false;
  }
  return true;
}
