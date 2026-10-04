/**
 * Phase 3 (W4): the automations an owner or admin can run (or dry-run) on
 * demand from the automation page - the scheduled, Trackpr-composed scans:
 * appointment reminders and estimate follow-up's check-ins (estimate
 * follow-up's first notification is dispatched to n8n, but its scheduled
 * check-ins are composed and sent by Trackpr, which is what a manual run
 * triggers). The one list both the page (whether to show the controls) and
 * the server actions (whether to allow the run) read, so they cannot drift.
 */
export const MANUAL_RUN_AUTOMATION_IDS: ReadonlySet<string> = new Set(["appointment-reminders", "estimate-followup"]);
