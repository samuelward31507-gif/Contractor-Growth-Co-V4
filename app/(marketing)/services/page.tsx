import type { Metadata } from "next";
import {
  Globe,
  Inbox,
  MessageSquare,
  Repeat,
  CalendarCheck2,
  FileText,
  RotateCcw,
  Star,
  BarChart3,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { Section, Container } from "../_components/section";
import { CtaLink } from "../_components/cta-button";

type Service = {
  icon: LucideIcon;
  title: string;
  what: string;
  why: string;
  handle: string;
};

const SERVICES: Service[] = [
  {
    icon: Globe,
    title: "Website / Lead Capture",
    what: "A website and inquiry process built to turn visitors into organized opportunities.",
    why: "A website that doesn't capture inquiries cleanly is the first place leads get lost.",
    handle: "Contractor Growth Co. designs and builds the site and lead-capture layer, or connects to your existing one.",
  },
  {
    icon: Inbox,
    title: "Lead Management",
    what: "Every inquiry — call, form, or message — organized into one system instead of scattered across texts and voicemail.",
    why: "You can't follow up with a lead you can't see.",
    handle: "We set up and manage the intake so every new opportunity lands in one place.",
  },
  {
    icon: MessageSquare,
    title: "Customer Communication",
    what: "A fast, organized response when a new opportunity comes in, with AI-assisted qualification inside defined safety boundaries.",
    why: "Slow response is one of the most common reasons a lead goes to a competitor.",
    handle: "We configure the response and qualification workflows, and route anything requiring your judgment to you.",
  },
  {
    icon: Repeat,
    title: "Follow-Up",
    what: "Automated follow-up for leads and open estimates so conversations keep moving instead of going quiet.",
    why: "Most lost opportunities aren't lost on the first conversation — they're lost in the follow-up gap.",
    handle: "We build and monitor the follow-up sequences behind the scenes.",
  },
  {
    icon: CalendarCheck2,
    title: "Scheduling",
    what: "Appointments kept organized from booking through completion.",
    why: "A missed or double-booked appointment costs you the job and the customer's trust.",
    handle: "We connect appointment management into the rest of the system.",
  },
  {
    icon: FileText,
    title: "Estimate Management",
    what: "Sent estimates tracked and followed up on instead of disappearing into an inbox.",
    why: "An unanswered estimate is a job you already quoted and might still lose.",
    handle: "We set up estimate follow-up so open quotes stay visible.",
  },
  {
    icon: RotateCcw,
    title: "Customer Reactivation",
    what: "A process for reconnecting with older leads and past customers.",
    why: "Past customers are often the easiest source of new work — if anyone reaches back out.",
    handle: "We build and run the reactivation outreach as part of the system.",
  },
  {
    icon: Star,
    title: "Reviews & Referrals",
    what: "A repeatable process for asking for reviews and surfacing referral opportunities after a job is completed.",
    why: "Happy customers rarely leave a review or send a referral unless someone asks at the right moment.",
    handle: "We set up the review and referral requests to trigger after completed work.",
  },
  {
    icon: BarChart3,
    title: "Business Visibility",
    what: "A clear view of pipeline, appointments, estimates, jobs, and system activity.",
    why: "You can't fix a leak you can't see.",
    handle: "Trackpr gives you the visibility; we make sure it reflects what's actually happening.",
  },
  {
    icon: Settings2,
    title: "Ongoing System Management",
    what: "Continued monitoring and adjustment of the system as your business changes.",
    why: "A system that's never maintained slowly drifts out of sync with how you actually work.",
    handle: "We monitor automation health and keep the system running — not just at setup, but ongoing.",
  },
];

export const metadata: Metadata = {
  title: "What We Build",
  description:
    "The services behind the Contractor Growth System — lead management, customer communication, follow-up, scheduling, estimate management, reactivation, reviews and referrals, and business visibility.",
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
            One managed system, organized around the outcomes that actually move your business forward.
          </p>
        </Container>
      </div>

      <Section>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {SERVICES.map((service) => (
            <div key={service.title} className="rounded-2xl border border-slate-200 p-7">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                <service.icon className="h-5 w-5" aria-hidden />
              </span>
              <h2 className="mt-5 text-lg font-semibold text-slate-900">{service.title}</h2>

              <dl className="mt-4 space-y-3">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">What is it?</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600">{service.what}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">Why it matters</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600">{service.why}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">What we handle</dt>
                  <dd className="mt-1 text-sm leading-relaxed text-slate-600">{service.handle}</dd>
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
            <CtaLink href="/get-started">Get Your Growth System</CtaLink>
          </div>
        </div>
      </Section>
    </>
  );
}
