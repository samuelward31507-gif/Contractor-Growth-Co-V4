import type { Metadata } from "next";
import { Inbox, Zap, ListChecks, Repeat, CalendarCheck2, RotateCcw, Star, Share2, LineChart, type LucideIcon } from "lucide-react";
import { Section, Eyebrow, Container } from "../_components/section";
import { CtaLink } from "../_components/cta-button";

type Service = {
  icon: LucideIcon;
  title: string;
  what: string;
  why: string;
  fit: string;
};

const SERVICES: Service[] = [
  {
    icon: Inbox,
    title: "Capture",
    what: "Every call, form, and message organized into one system instead of scattered across texts and voicemail.",
    why: "You can't follow up with a lead you can't see.",
    fit: "The entry point for every opportunity — the first step in the system.",
  },
  {
    icon: Zap,
    title: "Response",
    what: "A fast, organized response the moment a new opportunity comes in.",
    why: "Slow response is one of the most common reasons a lead goes to a competitor.",
    fit: "Happens immediately after capture, before anything else.",
  },
  {
    icon: ListChecks,
    title: "Qualification",
    what: "Incoming conversations reviewed, with AI-assisted qualification inside defined safety boundaries, so the right opportunities surface.",
    why: "Not every inquiry is ready to book — qualification decides what happens next.",
    fit: "Sits between response and follow-up, routing anything requiring judgment to you.",
  },
  {
    icon: Repeat,
    title: "Follow-Up",
    what: "Automated follow-up for leads and open estimates so conversations keep moving instead of going quiet.",
    why: "Most lost opportunities aren't lost in the first conversation — they're lost in the follow-up gap.",
    fit: "Runs continuously, alongside booking and estimate management.",
  },
  {
    icon: CalendarCheck2,
    title: "Booking",
    what: "Appointments and estimates kept organized from scheduling through completion.",
    why: "A missed or double-booked appointment costs you the job and the customer's trust.",
    fit: "Where a qualified opportunity becomes scheduled, tracked work.",
  },
  {
    icon: RotateCcw,
    title: "Reactivation",
    what: "A process for reconnecting with older leads and past customers.",
    why: "Past customers are often the easiest source of new work — if anyone reaches back out.",
    fit: "Runs in parallel, pulling cold opportunities back into the active system.",
  },
  {
    icon: Star,
    title: "Reviews",
    what: "A repeatable process for requesting a review after a job is completed.",
    why: "Happy customers rarely leave a review unless someone asks at the right moment.",
    fit: "Triggered automatically when a job is marked complete.",
  },
  {
    icon: Share2,
    title: "Referrals",
    what: "A natural opening to ask satisfied customers to send new business your way.",
    why: "Referrals are some of the highest-quality leads a business gets, and the easiest to lose by never asking.",
    fit: "Runs alongside review requests, right after a job wraps up.",
  },
  {
    icon: LineChart,
    title: "Analytics",
    what: "A clear view of pipeline, appointments, estimates, jobs, and system activity.",
    why: "You can't fix a leak you can't see.",
    fit: "Sits above the whole system, giving visibility into every stage at once.",
  },
];

export const metadata: Metadata = {
  title: "Services",
  description:
    "The Contractor Growth System's service architecture — capture, response, qualification, follow-up, booking, reactivation, reviews, referrals, and analytics.",
  alternates: { canonical: "/services" },
};

export default function ServicesPage() {
  return (
    <>
      <div className="border-b border-slate-200 bg-slate-50">
        <Container className="py-20 text-center sm:py-24">
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            What We Build.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
            Nine connected pieces, not nine separate products — each one part of the same system, built around the
            outcomes that actually move your business forward.
          </p>
        </Container>
      </div>

      <Section>
        <Eyebrow>Service architecture</Eyebrow>
        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-2">
          {SERVICES.map((service, index) => (
            <div key={service.title} className="rounded-2xl border border-slate-200 p-7">
              <div className="flex items-center justify-between">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                  <service.icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="text-xs font-semibold text-slate-400">{String(index + 1).padStart(2, "0")}</span>
              </div>
              <h2 className="mt-5 text-lg font-semibold text-slate-900">{service.title}</h2>

              <dl className="mt-4 space-y-3">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">What it is</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600">{service.what}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Why it matters</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600">{service.why}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Where it fits</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600">{service.fit}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </Section>

      <Section tone="dark">
        <div className="mx-auto max-w-xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">One system. Built and managed.</h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-300">
            These aren&apos;t separate products to buy piecemeal — they&apos;re one growth system built around your
            business.
          </p>
          <div className="mt-8">
            <CtaLink href="/signup">Get Started</CtaLink>
          </div>
        </div>
      </Section>
    </>
  );
}
