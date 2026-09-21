import type { Metadata } from "next";
import { ClipboardCheck, Hammer, Rocket, Gauge, TrendingUp, type LucideIcon } from "lucide-react";
import { Section, SectionHeading, Eyebrow, Container } from "../_components/section";
import { CtaLink } from "../_components/cta-button";
import { SYSTEM_STEPS } from "@/lib/site/system-steps";

export const metadata: Metadata = {
  title: "How It Works",
  description:
    "See exactly how Contractor Growth Co. audits, builds, launches, manages, and improves the system that captures, responds to, qualifies, follows up with, and tracks every opportunity in your business.",
  alternates: { canonical: "/how-it-works" },
};

const METHODOLOGY: { phase: string; icon: LucideIcon; title: string; description: string }[] = [
  {
    phase: "01",
    icon: ClipboardCheck,
    title: "Audit",
    description: "We map out how leads move through your business today — and where they're currently getting lost.",
  },
  {
    phase: "02",
    icon: Hammer,
    title: "Build",
    description: "We build the system around your business — capture, response, qualification, follow-up, and tracking.",
  },
  {
    phase: "03",
    icon: Rocket,
    title: "Launch",
    description: "The system goes live, connected to how your business already operates day to day.",
  },
  {
    phase: "04",
    icon: Gauge,
    title: "Manage",
    description: "We monitor and manage it on an ongoing basis — this isn't a one-time setup we walk away from.",
  },
  {
    phase: "05",
    icon: TrendingUp,
    title: "Improve",
    description: "As your business and lead volume change, the system gets refined to keep up with it.",
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <div className="border-b border-slate-200 bg-slate-50">
        <Container className="py-20 text-center sm:py-24">
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            See How the Contractor Growth System Works.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
            A five-phase process to build and manage the system around your business — not a one-time setup, an
            ongoing service.
          </p>
        </Container>
      </div>

      <Section>
        <Eyebrow>Our process</Eyebrow>
        <h2 className="mt-3 max-w-xl text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
          Five Phases. One Ongoing System.
        </h2>

        <ol className="relative mt-14 max-w-2xl">
          <span aria-hidden className="absolute left-[23px] top-2 bottom-2 w-px bg-slate-200" />
          {METHODOLOGY.map((item) => (
            <li key={item.phase} className="relative flex gap-6 pb-12 last:pb-0">
              <span className="relative z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700">
                <item.icon className="h-5 w-5" aria-hidden />
              </span>
              <div className="pt-1.5">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-xs font-semibold text-slate-400">{item.phase}</span>
                  <p className="text-xl font-semibold text-slate-900">{item.title}</p>
                </div>
                <p className="mt-1.5 max-w-lg text-[15px] leading-relaxed text-slate-600">{item.description}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section tone="subtle">
        <SectionHeading
          eyebrow="The system in action"
          title={
            <>
              Customer submits an inquiry at <span className="text-emerald-700">7:42 PM.</span>
            </>
          }
          description="Here's how the system carries that one inquiry through every stage — the same sequence every opportunity in your business moves through."
        />

        <ol className="mt-14 space-y-4">
          {SYSTEM_STEPS.map((step, index) => (
            <li
              key={step.key}
              className="flex flex-col gap-4 rounded-2xl border border-slate-200 p-6 sm:flex-row sm:items-start sm:gap-6 sm:p-7"
            >
              <div className="flex items-center gap-4 sm:flex-col sm:items-center sm:gap-2">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
                  <step.icon className="h-5 w-5" aria-hidden />
                </span>
                <span className="text-xs font-semibold text-slate-400">{String(index + 1).padStart(2, "0")}</span>
              </div>
              <div>
                <p className="text-lg font-semibold text-slate-900">{step.label}</p>
                <p className="mt-1.5 text-[15px] leading-relaxed text-slate-600">{step.longDescription}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section tone="dark">
        <div className="mx-auto max-w-xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            See it built around your business.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-slate-300">
            Every business handles leads a little differently. Let&apos;s look at how yours currently works.
          </p>
          <div className="mt-8">
            <CtaLink href="/signup">Get Started</CtaLink>
          </div>
        </div>
      </Section>
    </>
  );
}
