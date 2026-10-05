import type { Metadata } from "next";
import { CONTAINER, Eyebrow } from "../_components/ui";
import { GetStartedForm } from "./get-started-form";

const STEPS = [
  "We look at how your business handles opportunities today.",
  "We find where revenue is slipping between stages.",
  "We show you how Trackpr would run that lifecycle.",
  "If it's a fit, we set it up with you.",
];

export const metadata: Metadata = {
  title: "Get started with Trackpr",
  description:
    "Tell Cinder about your business and where opportunities are being lost, and see how Trackpr - Cinder's revenue operating system - would run your revenue lifecycle.",
  alternates: { canonical: "/get-started" },
};

/** Trackpr's intake - the existing mailto form (no backend), on the Cinder site. */
export default function GetStartedPage() {
  return (
    <div className="bg-cinder-canvas">
      <div className={`${CONTAINER} py-20 sm:py-24`}>
        <div className="grid grid-cols-1 gap-14 lg:grid-cols-2 lg:gap-20">
          <div>
            <Eyebrow>Trackpr · Get started</Eyebrow>
            <h1 className="mt-6 text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.04em] text-cinder-ink sm:text-[56px]">
              Get started with Trackpr<span className="text-cinder-accent">.</span>
            </h1>
            <p className="mt-6 max-w-[520px] text-pretty text-lg leading-relaxed text-cinder-ink-2">
              Trackpr is the first revenue operating system from Cinder, live today beginning with contractors and the trades. Tell us about your business and where
              opportunities are being lost — we&apos;ll take it from there.
            </p>

            <div className="mt-10">
              <p className="font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cinder-ink-3">What happens next</p>
              <ol className="mt-4 space-y-4">
                {STEPS.map((step, index) => (
                  <li key={step} className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cinder-surface text-xs font-semibold text-cinder-ink-3 ring-1 ring-cinder-line">
                      {index + 1}
                    </span>
                    <p className="pt-0.5 text-[15px] text-cinder-ink-2">{step}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>

          <div>
            <GetStartedForm />
          </div>
        </div>
      </div>
    </div>
  );
}
