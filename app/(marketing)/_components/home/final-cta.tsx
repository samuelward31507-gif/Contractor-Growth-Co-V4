import { Section } from "../section";
import { CtaLink } from "../cta-button";

export function FinalCta() {
  return (
    <Section tone="dark">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Stop Losing the Leads You&apos;re Already Paying For.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-300">
          Let&apos;s look at how your business currently handles leads, follow-up, estimates, and customers — and
          identify where the opportunities are getting lost.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <CtaLink href="/get-started">Get Your Growth System</CtaLink>
          <CtaLink href="/how-it-works" variant="secondaryDark">
            See How It Works
          </CtaLink>
        </div>
      </div>
    </Section>
  );
}
