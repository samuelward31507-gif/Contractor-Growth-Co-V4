import Link from "next/link";
import { SectionCard } from "@/lib/ui/section-card";
import { DEAL_STAGES, DEAL_STAGE_LABELS, type DealStage } from "@/lib/founder/model";
import { COLD_ATTEMPTS, COLD_DAYS, METRIC_PERIODS, STALL_DAYS, ofLabel, type MeetingEntry, type MetricPeriod, type SalesEntry, type SalesMetrics, type SalesToday } from "@/lib/founder/sales";
import { formatDateKey, formatDateTime, formatTotals } from "@/lib/founder/format";

const SUBHEAD = "text-xs font-semibold uppercase tracking-wide text-ink-3";
const dealLink = (id: string) => `/founder/deals?deal=${encodeURIComponent(id)}`;

function EntryList({ entries }: { entries: SalesEntry[] }) {
  return (
    <ul className="divide-y divide-line">
      {entries.slice(0, 6).map((e) => (
        <li key={e.deal.id} className="py-2">
          <Link href={dealLink(e.deal.id)} className="block hover:underline">
            <span className="block text-sm font-medium text-ink">{e.deal.name}</span>
            <span className="block text-xs text-ink-3">{e.basis}</span>
          </Link>
        </li>
      ))}
      {entries.length > 6 ? <li className="py-2 text-xs text-ink-3">+{entries.length - 6} more</li> : null}
    </ul>
  );
}

function MeetingList({ meetings, timeZone, outcome }: { meetings: MeetingEntry[]; timeZone: string; outcome?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {meetings.slice(0, 6).map((m) => (
        <li key={`${m.deal.id}:${m.startsAt}`} className="py-2">
          <Link href={dealLink(m.deal.id)} className="block hover:underline">
            <span className="block text-sm font-medium text-ink">{m.deal.name}</span>
            <span className="block text-xs text-ink-3">
              {formatDateTime(m.startsAt, timeZone)} · {m.source === "calendar" ? "on your calendar" : "booking logged"}
              {outcome ? " · log held or no-show" : ""}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * "What needs doing in sales" - every entry rests on a recorded fact (a due
 * date, a logged activity, a calendar meeting), stated next to it. Empty
 * sections are left out; nothing is shown as done that wasn't recorded.
 */
export function SalesTodayPanel({ today, timeZone, historyAvailable }: { today: SalesToday; timeZone: string; historyAvailable: boolean }) {
  const sections: { id: string; title: string; hint: string; body: React.ReactNode; count: number }[] = [
    { id: "outreach", title: "Outreach due", hint: "Identified or qualified, next action due today or overdue", body: <EntryList entries={today.outreachDue} />, count: today.outreachDue.length },
    { id: "followups", title: "Follow-ups due", hint: "In conversation, follow-up due today or overdue", body: <EntryList entries={today.followUpsDue} />, count: today.followUpsDue.length },
    { id: "meetings", title: "Meetings - next 7 days", hint: "Calendar meetings linked to a deal, or bookings logged with a time", body: <MeetingList meetings={today.meetings} timeZone={timeZone} />, count: today.meetings.length },
    { id: "outcome", title: "Meeting outcome not recorded", hint: "The meeting time has passed with no held / no-show logged", body: <MeetingList meetings={today.outcomeMissing} timeZone={timeZone} outcome />, count: today.outcomeMissing.length },
    { id: "proposals", title: "Proposals waiting", hint: "Proposal sent or negotiating, longest wait first", body: <EntryList entries={today.proposalsWaiting} />, count: today.proposalsWaiting.length },
    { id: "stalled", title: "Stalled", hint: `Past first reply, nothing recorded for ${STALL_DAYS}+ days, nothing scheduled`, body: <EntryList entries={today.stalled} />, count: today.stalled.length },
    { id: "cold", title: "Gone cold", hint: `${COLD_ATTEMPTS}+ outreach attempts or ${COLD_DAYS}+ days with no reply recorded`, body: <EntryList entries={today.cold} />, count: today.cold.length },
    { id: "nonext", title: "No next action", hint: "Open deals with no next step or date", body: <EntryList entries={today.noNextAction} />, count: today.noNextAction.length },
  ];
  const shown = sections.filter((s) => s.count > 0);
  return (
    <SectionCard title="Sales today" description="Who to contact, what's booked and what's slipping - from your due dates and recorded activity.">
      {!historyAvailable ? <p className="mb-3 text-xs text-warning-text">Sales history isn&rsquo;t enabled on this database yet, so meetings, stalls and cold prospects can&rsquo;t be worked out. Due dates still show.</p> : null}
      {shown.length === 0 ? (
        <p className="text-sm text-ink-3">Nothing due, booked or slipping. Add a deal or set next actions to build the day&rsquo;s list.</p>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((s) => (
            <section key={s.id} aria-labelledby={`sales-${s.id}`}>
              <h3 id={`sales-${s.id}`} className={`${SUBHEAD} flex items-center justify-between`}>
                {s.title}
                <span className="tabular-nums">{s.count}</span>
              </h3>
              <p className="mt-0.5 text-xs text-ink-4">{s.hint}</p>
              <div className="mt-1">{s.body}</div>
            </section>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Measured from recorded activity only. The pipeline snapshot (counts by
 * current stage) is shown apart from conversion, which exists only from the
 * first recorded activity onward.
 */
export function SalesMetricsPanel({ metrics, period, byStage, timeZone }: { metrics: SalesMetrics; period: MetricPeriod; byStage: Record<DealStage, number>; timeZone: string }) {
  const c = metrics.cohort;
  const a = metrics.activity;
  const stageLoss = Object.entries(metrics.lost.fromStage) as [DealStage | "not_recorded", number][];
  return (
    <SectionCard
      title="Sales results"
      description={`${formatDateKey(metrics.fromKey, { month: "short", day: "numeric", year: "numeric" })} – ${formatDateKey(metrics.toKey, { month: "short", day: "numeric", year: "numeric" })}`}
      action={
        <nav aria-label="Period" className="flex gap-1">
          {METRIC_PERIODS.map((p) => (
            <Link key={p} href={`/founder/deals?period=${p}`} aria-current={p === period ? "page" : undefined} className={`inline-flex min-h-8 items-center rounded-full border px-2.5 text-xs font-medium ${p === period ? "border-ink bg-ink text-white" : "border-line text-ink-2 hover:border-line-strong"}`}>
              {p === 365 ? "12 mo" : `${p} d`}
            </Link>
          ))}
        </nav>
      }
    >
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section aria-labelledby="metrics-activity">
          <h3 id="metrics-activity" className={SUBHEAD}>Recorded activity</h3>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {[
              ["Outreach sent", a.outreach],
              ["Replies", a.reply_received],
              ["Meetings booked", a.meeting_booked],
              ["Meetings held", a.meeting_held],
              ["No-shows", a.meeting_no_show],
              ["Demos / audits", a.demo_completed + a.audit_completed],
              ["Proposals sent", a.proposal_sent],
            ].map(([label, value]) => (
              <div key={label as string} className="flex justify-between gap-2">
                <dt className="text-ink-3">{label}</dt>
                <dd className="tabular-nums text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="metrics-conversion">
          <h3 id="metrics-conversion" className={SUBHEAD}>Conversion (measured)</h3>
          {metrics.measuredSince == null ? (
            <p className="mt-2 text-sm text-ink-3">Not measured yet - conversion starts with the first activity you log.</p>
          ) : (
            <>
              <p className="mt-1 text-xs text-ink-4">Of prospects first contacted in this period - what has been recorded since. Measured from {formatDateTime(metrics.measuredSince, timeZone)}; earlier deals only have their current stage.</p>
              <dl className="mt-2 space-y-1 text-sm">
                {[
                  ["Contacted", String(c.outreached)],
                  ["Replied", ofLabel(c.replied, c.outreached)],
                  ["Meeting held", ofLabel(c.meetingHeld, c.outreached)],
                  ["Proposal sent", ofLabel(c.proposalSent, c.outreached)],
                  ["Won", ofLabel(c.won, c.outreached)],
                ].map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-2">
                    <dt className="text-ink-3">{label}</dt>
                    <dd className="tabular-nums text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </section>
        <section aria-labelledby="metrics-won">
          <h3 id="metrics-won" className={SUBHEAD}>Won and lost</h3>
          <dl className="mt-2 space-y-1 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-3">Deals won</dt>
              <dd className="tabular-nums text-ink">{metrics.won.count}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-3">Setup fees agreed</dt>
              <dd className="tabular-nums text-ink">{formatTotals(metrics.won.setup) ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-3">Monthly fees added</dt>
              <dd className="tabular-nums text-ink">{formatTotals(metrics.won.monthly) ? `${formatTotals(metrics.won.monthly)}/mo` : "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-3">Deals lost</dt>
              <dd className="tabular-nums text-ink">{metrics.lost.count}</dd>
            </div>
          </dl>
          <p className="mt-1 text-xs text-ink-4">Agreed terms (contracted), not payments received.</p>
          {stageLoss.length ? (
            <p className="mt-2 text-xs text-ink-3">
              Lost from: {stageLoss.map(([stage, n]) => `${stage === "not_recorded" ? "stage not recorded" : DEAL_STAGE_LABELS[stage]} ${n}`).join(" · ")}
            </p>
          ) : null}
          {metrics.lost.reasons.length ? <p className="mt-1 text-xs text-ink-3">Reasons: {metrics.lost.reasons.slice(0, 4).map((r) => `${r.reason} (${r.count})`).join(" · ")}</p> : null}
        </section>
      </div>
      <section aria-labelledby="metrics-snapshot" className="mt-6 border-t border-line pt-4">
        <h3 id="metrics-snapshot" className={SUBHEAD}>Pipeline now (snapshot)</h3>
        <p className="mt-1 text-xs text-ink-4">Where every deal sits today - not a measure of how deals moved.</p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {DEAL_STAGES.map((s) => (
            <li key={s} className="flex gap-1.5">
              <span className="text-ink-3">{DEAL_STAGE_LABELS[s]}</span>
              <span className="tabular-nums text-ink">{byStage[s]}</span>
            </li>
          ))}
        </ul>
      </section>
    </SectionCard>
  );
}
