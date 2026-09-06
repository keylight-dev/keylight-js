/**
 * Server-owned product settings: trial length and free tier.
 *
 * These two values belong to the server, not to the build. The fields on
 * `KeylightConfig` are demoted to a *seed*, used only before this install has
 * ever reached the server.
 *
 * Both fields are optional, and **absence is meaningful**: `undefined` means
 * "never heard from the server", which is a different thing from `0` / `false`.
 * A tenant who turns trials off in the dashboard sends a real `0`; collapsing
 * that into "absent" would fall back to the seed and silently re-enable the
 * trial they just disabled. Never test these with `??` against a truthiness
 * check, and never persist them through a shortcut that writes `0` for missing.
 */
export interface CachedProductConfig {
  trialDurationDays?: number;
  freeTierEnabled?: boolean;
}

/**
 * The wire shape, as it appears in the `/config` response body and riding on
 * `validate` and keyless-beacon responses.
 *
 * The signature fields are part of the frozen wire contract. They are checked
 * by `verifyConfig` when `requireSignedConfig` is set, and carried but
 * unenforced otherwise.
 */
export interface ProductConfigFields {
  trial_duration_days?: number | null;
  free_tier_enabled?: boolean | null;
  issued_at?: number | null;
  expires_at?: number | null;
  kid?: string | null;
  signature?: string | null;
}

/** Read the two settings off any response body, ignoring everything else. */
export function readConfigFields(body: unknown): ProductConfigFields {
  if (typeof body !== "object" || body === null) return {};
  const o = body as Record<string, unknown>;
  const out: ProductConfigFields = {};
  if (typeof o.trial_duration_days === "number") out.trial_duration_days = o.trial_duration_days;
  if (typeof o.free_tier_enabled === "boolean") out.free_tier_enabled = o.free_tier_enabled;
  // The signature rides with the fields on every route that delivers them. A
  // route that read the settings but dropped their signature would be a way
  // around `requireSignedConfig`, so it is read here rather than per-caller.
  if (typeof o.issued_at === "number") out.issued_at = o.issued_at;
  if (typeof o.expires_at === "number") out.expires_at = o.expires_at;
  if (typeof o.kid === "string") out.kid = o.kid;
  if (typeof o.signature === "string") out.signature = o.signature;
  return out;
}

/** True when the response carried neither setting — an older worker, or a route
 *  with nothing to say about product config. */
export function isEmptyConfig(f: ProductConfigFields): boolean {
  return f.trial_duration_days == null && f.free_tier_enabled == null;
}

/**
 * Merge server-sent settings into the cache, **field by field**.
 *
 * A response carrying neither field leaves the cache untouched — an older worker
 * that knows nothing about these settings must not wipe what this install
 * already learned. Each field is written only when the server actually sent it,
 * rather than overwriting the pair.
 */
export function mergeConfig(cached: CachedProductConfig, fields: ProductConfigFields): CachedProductConfig {
  const next: CachedProductConfig = { ...cached };
  if (typeof fields.trial_duration_days === "number") next.trialDurationDays = fields.trial_duration_days;
  if (typeof fields.free_tier_enabled === "boolean") next.freeTierEnabled = fields.free_tier_enabled;
  return next;
}
