import { Resend } from "resend";

/**
 * Final Batch 4: platform-level operational alerts - for the Trackpr
 * operator, not a contractor (contractor-facing problems already go through
 * automation_incidents + notifyFounder, lib/automation-health/service.ts).
 *
 * Every alert is ONE structured JSON log line, always:
 *
 *   {"trackpr_ops_alert":true,"severity":"critical","source":"...","code":"...","message":"...","context":{...},"at":"..."}
 *
 * so a log drain / Vercel log search on `trackpr_ops_alert` finds every one.
 * An alert raised with `notify: true` is also emailed to OPS_ALERT_EMAIL
 * through the Resend account the app already uses (RESEND_API_KEY,
 * EMAIL_FROM). Without OPS_ALERT_EMAIL nothing is emailed - the log line is
 * still written (see docs/release-rollback-runbook.md for configuring it).
 *
 * Safety:
 *   - context is sanitized: only primitive values, short strings, and no key
 *     that could carry a secret, a credential, a phone number, an email
 *     address or customer message text;
 *   - the same code is emailed at most once per OPS_ALERT_EMAIL_WINDOW_MS
 *     per server instance (callers are low-frequency - the once-daily
 *     watchdog - so this is a backstop, not the main storm control);
 *   - never throws: an unavailable email provider is logged and swallowed.
 */

export type OpsAlertSeverity = "critical" | "warning";
export type OpsAlertContext = Record<string, string | number | boolean | null | undefined>;

export type OpsAlert = {
  severity: OpsAlertSeverity;
  /** Where it happened, e.g. "automation.health". */
  source: string;
  /** Stable machine code, e.g. "health_tick_phase_failed" - the dedupe key. */
  code: string;
  /** One operator-facing sentence. Never customer content or provider error text. */
  message: string;
  context?: OpsAlertContext;
  /** Also email OPS_ALERT_EMAIL. Use only from low-frequency callers. */
  notify?: boolean;
};

export type OpsAlertResult = { logged: true; emailed: boolean; emailSkipped?: "not_requested" | "not_configured" | "deduplicated" | "send_failed" };

export const OPS_ALERT_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const MAX_CONTEXT_STRING = 200;
const MAX_CONTEXT_KEYS = 20;
/** Keys that could carry a secret, a credential or personal / customer content are always dropped. */
const UNSAFE_CONTEXT_KEY = /secret|token|password|passwd|key|auth|credential|cookie|signature|phone|email|body|content|text|address|name/i;

export function sanitizeOpsContext(context: OpsAlertContext | undefined): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  if (!context) return safe;
  for (const [key, value] of Object.entries(context).slice(0, MAX_CONTEXT_KEYS)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) || UNSAFE_CONTEXT_KEY.test(key)) continue;
    if (value === undefined) continue;
    if (value === null || typeof value === "boolean") safe[key] = value;
    else if (typeof value === "number") safe[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "string") safe[key] = value.length > MAX_CONTEXT_STRING ? `${value.slice(0, MAX_CONTEXT_STRING - 1)}…` : value;
  }
  return safe;
}

const lastEmailedAt = new Map<string, number>();

export type OpsAlertDeps = {
  env?: Record<string, string | undefined>;
  now?: () => number;
  log?: (line: string) => void;
  sendEmail?: (email: { to: string; from: string; subject: string; text: string }, apiKey: string) => Promise<{ error?: unknown }>;
};

async function sendViaResend(email: { to: string; from: string; subject: string; text: string }, apiKey: string): Promise<{ error?: unknown }> {
  const result = await new Resend(apiKey).emails.send(email);
  return { error: result.error ?? undefined };
}

export async function reportOpsAlert(alert: OpsAlert, deps: OpsAlertDeps = {}): Promise<OpsAlertResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const context = sanitizeOpsContext(alert.context);
  const at = new Date(now()).toISOString();
  const environment = env.VERCEL_ENV ?? (env.NODE_ENV === "production" ? "production" : "development");

  try {
    log(JSON.stringify({ trackpr_ops_alert: true, severity: alert.severity, source: alert.source, code: alert.code, message: alert.message, environment, context, at }));
  } catch {
    /* logging must never throw */
  }

  if (!alert.notify) return { logged: true, emailed: false, emailSkipped: "not_requested" };
  const to = env.OPS_ALERT_EMAIL;
  const from = env.EMAIL_FROM;
  const apiKey = env.RESEND_API_KEY;
  if (!to || !from || !apiKey) return { logged: true, emailed: false, emailSkipped: "not_configured" };

  const dedupeKey = `${alert.source}:${alert.code}`;
  const last = lastEmailedAt.get(dedupeKey);
  if (last !== undefined && now() - last < OPS_ALERT_EMAIL_WINDOW_MS) return { logged: true, emailed: false, emailSkipped: "deduplicated" };

  const text = [
    `${alert.severity.toUpperCase()}: ${alert.message}`,
    "",
    `Source: ${alert.source}`,
    `Code: ${alert.code}`,
    `Environment: ${environment}`,
    `At: ${at}`,
    "",
    "Context:",
    ...Object.entries(context).map(([key, value]) => `  ${key}: ${String(value)}`),
    "",
    "See docs/release-rollback-runbook.md for what to check.",
  ].join("\n");

  try {
    const result = await (deps.sendEmail ?? sendViaResend)({ to, from, subject: `[Trackpr ${alert.severity}] ${alert.code} (${environment})`, text }, apiKey);
    if (result.error) throw result.error;
    lastEmailedAt.set(dedupeKey, now());
    return { logged: true, emailed: true };
  } catch (error) {
    try {
      log(JSON.stringify({ trackpr_ops_alert: true, severity: "warning", source: "ops.alert", code: "ops_alert_email_failed", message: "Could not email an operational alert.", environment, context: { alertCode: alert.code, reason: error instanceof Error ? error.name : "unknown" }, at }));
    } catch {
      /* logging must never throw */
    }
    return { logged: true, emailed: false, emailSkipped: "send_failed" };
  }
}

/** Tests only: forget the per-instance email dedupe. */
export function resetOpsAlertDedupeForTests(): void {
  lastEmailedAt.clear();
}
