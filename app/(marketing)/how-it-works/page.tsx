import type { Metadata } from "next";
import { Section, SectionHeading, Container } from "../_components/section";
import { CtaLink } from "../_components/cta-button";
import { SYSTEM_STEPS } from "@/lib/site/system-steps";

export const metadata: Metadata = {
  title: "How It Works",
  description:
    "See exactly how the Contractor Growth System captures, responds to, qualifies, follows up with, and tracks every opportunity in your business.",
  alternates: { canonical: "/how-it-works" },
};

export default function HowItWorksPage() {
  return (
    <>
      <div className="border-b border-slate-200 bg-slate-50">
        <Container className="py-20 text-center sm:py-24">
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
            See How the Contractor Growth System Works.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
            Every opportunity moves through the same system — from the first inquiry to the finished job and
            everything after it.
          </p>
        </Container>
      </div>

      <Section>
        <SectionHeading
          eyebrow="A real example"
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
            <CtaLink href="/get-started">Get Your Growth System</CtaLink>
          </div>
        </div>
      </Section>
    </>
  );
}
