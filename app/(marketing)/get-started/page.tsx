import type { Metadata } from "next";
import { Container } from "../_components/section";
import { GetStartedForm } from "./get-started-form";

const STEPS = [
  "We look at your current process.",
  "We identify the biggest leaks.",
  "We show you how the system would work.",
  "If it makes sense, we build it.",
];

export const metadata: Metadata = {
  title: "Get Started",
  description:
    "Let's build your growth system. Tell us a little about your business and where opportunities are currently being lost.",
  alternates: { canonical: "/get-started" },
};

export default function GetStartedPage() {
  return (
    <div className="bg-slate-50">
      <Container className="py-20 sm:py-24">
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-2 lg:gap-20">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight text-slate-900 sm:text-5xl">
              Let&apos;s Build Your Growth System.
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-slate-600">
              Tell us a little about your business and where opportunities are currently being lost — we&apos;ll
              take it from there.
            </p>

            <div className="mt-10">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">What happens next</p>
              <ol className="mt-4 space-y-4">
                {STEPS.map((step, index) => (
                  <li key={step} className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-500 ring-1 ring-slate-200">
                      {index + 1}
                    </span>
                    <p className="pt-0.5 text-[15px] text-slate-700">{step}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div>
            <GetStartedForm />
          </div>
        </div>
      </Container>
    </div>
  );
}
