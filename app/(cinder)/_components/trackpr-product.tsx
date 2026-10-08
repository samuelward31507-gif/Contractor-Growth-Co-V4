import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CinderMark } from "./logo";
import { TrackprShowcase } from "./trackpr-showcase";
import { TrackprTile } from "./sections";
import { Reveal } from "./reveal";
import { Badge, Button, CONTAINER, H2, Section } from "./ui";
import { FUTURE_VERTICALS, GET_STARTED_HREF, TRACKPR_DEMO_HREF } from "./content";

/**
 * /trackpr - Trackpr's product page on the Cinder site.
 *
 * Product truth: every capability named here exists in the Trackpr
 * application in this repository - the Today screen and its "Needs your
 * attention" list, Money, Inbox, Schedule (with Google Calendar sync),
 * estimates with a customer approval link, jobs, invoices with an online
 * payment page, and the automation catalogue (lib/automation/catalog.ts:
 * Missed Call Recovery, Instant Lead Follow-Up, Inbound Customer Reply,
 * Appointment Reminders, Automatic No-Show Detection, Estimate Follow-Up,
 * Job Lifecycle, Review & Referral Follow-Up, Invoice Reminders, Lead
 * Reactivation, Old Customer Reactivation). No customers, results,
 * pricing or integrations beyond those are claimed.
 */

const QUESTIONS = [
  {
    q: "What is happening with my revenue?",
    a: "Today opens on the figures that matter this morning — new leads, appointments, conversations waiting on you, and what is unpaid. Money shows quotes out, accepted work, jobs in progress and invoices.",
    area: "Today · Money",
  },
  {
    q: "What needs attention?",
    a: "One prioritized list — operational problems first, then the most time-sensitive opportunities — each with the reason it is there.",
    area: "Needs your attention",
  },
  {
    q: "What should I do next?",
    a: "Every item carries its next step: open the conversation, follow up the estimate, create the invoice.",
    area: "Next action",
  },
  {
    q: "Where are opportunities getting stuck?",
    a: "Where the work stands shows every stage at a glance — leads, quoted, accepted, in progress, ready to invoice, unpaid — and Opportunities surfaces customers to win back and reviews or referrals to ask for.",
    area: "Where the work stands · Opportunities",
  },
  {
    q: "What is happening between lead and payment?",
    a: "Conversations, appointments, estimates, jobs and invoices live on one record, so the whole path from first contact to paid is visible.",
    area: "Inbox · Schedule · Estimates · Jobs · Invoices",
  },
] as const;

const LIFECYCLE = [
  { stage: "Lead", does: "Website form capture, missed-call recovery by text, and leads added by hand - all in one place." },
  { stage: "Response", does: "An instant first reply to every new lead, and drafted replies to inbound texts that hand off to you when a person is needed." },
  { stage: "Qualification", does: "Lead temperature and status, so hot leads and qualified-but-unbooked leads surface first." },
  { stage: "Appointment", does: "Booking against your real availability, Google Calendar sync, reminders, and no-show detection." },
  { stage: "Estimate", does: "Estimates with a customer approval link, and follow-ups while they wait for a reply." },
  { stage: "Job", does: "Jobs from accepted estimates, a kickoff notice, and review and referral requests when the work is done." },
  { stage: "Payment", does: "Invoices with an online payment page, payment history, and reminders when an invoice goes overdue." },
] as const;

export function TrackprHero() {
  return (
    <section aria-labelledby="trackpr-hero-title" className="pb-16 pt-14 sm:pb-20 sm:pt-24 lg:pt-28">
      <div className={CONTAINER}>
        <div className="cinder-rise flex flex-wrap items-center gap-3 text-sm text-cinder-ink-3">
          <span className="inline-flex items-center gap-2 font-medium text-cinder-ink">
            <CinderMark className="h-5 w-5" />
            Cinder
          </span>
          <span aria-hidden className="h-px w-8 bg-cinder-line-strong" />
          <span className="inline-flex items-center gap-2 font-medium text-cinder-ink">
            <TrackprTile />
            Trackpr
          </span>
          <span className="sr-only">: Trackpr is a product of Cinder Revenue Company.</span>
        </div>
        <h1 id="trackpr-hero-title" className="cinder-rise mt-8 text-[clamp(3rem,11vw,7rem)] font-semibold leading-[0.95] tracking-[-0.05em]" style={{ animationDelay: "60ms" }}>
          Trackpr<span className="text-cinder-accent">.</span>
        </h1>
        <p className="cinder-rise mt-5 max-w-[760px] text-balance text-[26px] font-medium leading-[1.15] tracking-[-0.025em] text-cinder-ink-2 sm:text-[36px]" style={{ animationDelay: "100ms" }}>
          The first revenue operating system from Cinder.
        </p>
        <p className="cinder-rise mt-7 max-w-[560px] text-pretty text-[18px] leading-relaxed text-cinder-ink-2 sm:text-[19px]" style={{ animationDelay: "140ms" }}>
          One place to see what is happening with your revenue, what needs attention, and what should happen next — from the first lead to the final payment.
        </p>
        <div className="cinder-rise mt-9 flex flex-col gap-3 sm:flex-row sm:items-center" style={{ animationDelay: "180ms" }}>
          <Button href={GET_STARTED_HREF} arrow size="lg">
            Get started with Trackpr
          </Button>
          <Button href={TRACKPR_DEMO_HREF} variant="secondary" size="lg">
            Try the interactive demo
          </Button>
        </div>
        <p className="cinder-rise mt-8 flex items-center gap-2.5 text-sm text-cinder-ink-3" style={{ animationDelay: "220ms" }}>
          <Badge tone="accent">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cinder-accent" />
            Live
          </Badge>
          Live today, beginning with contractors and the trades.
        </p>
      </div>
    </section>
  );
}

export function TrackprProductShowcase() {
  return (
    <div className="border-y border-cinder-line bg-cinder-surface py-12 sm:py-16 lg:py-20">
      <div className={CONTAINER}>
        <Reveal>
          <TrackprShowcase />
        </Reveal>
      </div>
    </div>
  );
}

export function TrackprQuestions() {
  return (
    <Section id="questions" eyebrow="What Trackpr answers" title="The questions a revenue system should answer." intro="Every morning, in one place, without digging through inboxes, calendars and spreadsheets.">
      <ol className="mt-14 divide-y divide-cinder-line border-y border-cinder-line sm:mt-20">
        {QUESTIONS.map((item, i) => (
          <li key={item.q}>
            <Reveal delay={i * 60} className="grid gap-3 py-7 sm:grid-cols-[48px_minmax(0,5fr)_minmax(0,6fr)] sm:gap-8 sm:py-9">
              <span className="font-mono text-[11px] text-cinder-ink-3 sm:pt-2">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="text-balance text-[22px] font-semibold leading-tight tracking-[-0.025em] sm:text-[26px]">{item.q}</h3>
              <div>
                <p className="text-pretty text-[16px] leading-relaxed text-cinder-ink-2 sm:text-[17px]">{item.a}</p>
                <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.1em] text-cinder-ink-3">In Trackpr · {item.area}</p>
              </div>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  );
}

export function TrackprLifecycle() {
  return (
    <Section
      tone="night"
      eyebrow="Built on the revenue lifecycle"
      title="Every stage, one connected record."
      intro="Trackpr follows each opportunity from first contact to payment, and keeps the follow-through moving at every stage."
    >
      <ol className="mt-14 grid gap-px overflow-hidden rounded-2xl bg-cinder-night-line inset-ring inset-ring-cinder-night-line sm:mt-20 sm:grid-cols-2 lg:grid-cols-4 [&>li:last-child]:sm:col-span-2 lg:[&>li:last-child]:col-span-1">
        {LIFECYCLE.map((item, i) => (
          <li key={item.stage} className="bg-cinder-night">
            <Reveal delay={i * 60} className="flex h-full flex-col p-6 sm:p-8">
              <span className="font-mono text-[11px] text-cinder-on-night-3">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="mt-6 text-[22px] font-semibold tracking-[-0.025em] sm:mt-10">{item.stage}</h3>
              <p className="mt-2 text-pretty text-[15px] leading-relaxed text-cinder-on-night-2">{item.does}</p>
            </Reveal>
          </li>
        ))}
        <li className="bg-cinder-night">
          <Reveal delay={LIFECYCLE.length * 60} className="flex h-full flex-col justify-between gap-6 p-6 sm:p-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-cinder-on-night-3">Across every stage</p>
            <p className="text-pretty text-[15px] leading-relaxed text-cinder-on-night-2">
              Reactivation for quiet leads and past customers, Analytics on how revenue moves, and a weekly summary for the owner.
            </p>
          </Reveal>
        </li>
      </ol>
    </Section>
  );
}

export function TrackprAvailability() {
  return (
    <Section eyebrow="Availability" title="Launching with the trades. Built to go further.">
      <div className="mt-14 grid gap-4 sm:mt-20 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <Reveal>
          <article className="flex h-full flex-col rounded-[24px] border border-cinder-line bg-cinder-surface p-7 shadow-[0_1px_2px_rgba(13,21,18,0.04)] sm:p-10">
            <div className="flex">
              <Badge tone="accent">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-cinder-accent" />
                Live today
              </Badge>
            </div>
            <h3 className="mt-10 text-[32px] font-semibold tracking-[-0.035em] sm:text-[40px]">Contractors and the trades</h3>
            <p className="mt-3 max-w-[540px] text-pretty text-[17px] leading-relaxed text-cinder-ink-2">
              Trackpr&apos;s first live vertical — shaped around how the trades win and deliver work: calls and forms, estimates, jobs and invoices.
            </p>
            <div className="mt-auto pt-10">
              <Button href={GET_STARTED_HREF} arrow>
                Get started with Trackpr
              </Button>
            </div>
          </article>
        </Reveal>
        <Reveal delay={90}>
          <div className="flex h-full flex-col rounded-[24px] border border-dashed border-cinder-line-strong p-7 sm:p-10">
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-cinder-ink-3">Coming next</p>
            <p className="mt-3 text-pretty text-[17px] leading-relaxed text-cinder-ink-2">
              Cinder is expanding into more revenue-heavy businesses. Trackpr does not support these yet.
            </p>
            <ul className="mt-8 flex flex-wrap gap-2">
              {FUTURE_VERTICALS.map((name) => (
                <li key={name} className="rounded-full px-3 py-1 text-[13px] text-cinder-ink-2 inset-ring inset-ring-cinder-line-strong">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

export function TrackprCta() {
  return (
    <section aria-labelledby="trackpr-cta-title" className="bg-cinder-night text-cinder-on-night">
      <div className={`${CONTAINER} py-24 sm:py-32`}>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end">
          <div>
            <TrackprTile className="h-11 w-11 rounded-xl text-[22px]" />
            <h2 id="trackpr-cta-title" className={`mt-10 ${H2}`}>
              See Trackpr run your revenue lifecycle.
            </h2>
          </div>
          <div className="lg:pb-2">
            <p className="max-w-[440px] text-pretty text-[17px] leading-relaxed text-cinder-on-night-2 sm:text-[19px]">
              Tell us how your business handles opportunities today. We&apos;ll show you where Trackpr fits.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href={GET_STARTED_HREF} variant="inverse" arrow size="lg">
                Get started with Trackpr
              </Button>
            </div>
            <Link href="/" className="group mt-8 inline-flex items-center gap-1.5 rounded text-sm text-cinder-on-night-3 transition-colors hover:text-cinder-on-night focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cinder-accent-on-night">
              <span aria-hidden className="h-[5px] w-[5px] shrink-0 rotate-45 bg-cinder-accent-on-night" />
              <span className="ml-1 font-mono text-[11px] font-medium uppercase tracking-[0.14em]">Trackpr is a product of Cinder Revenue Company</span>
              <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" strokeWidth={1.75} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
