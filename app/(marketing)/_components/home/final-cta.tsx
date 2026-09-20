import { Section } from "../section";
import { CtaLink } from "../cta-button";

export function FinalCta() {
  return (
    <Section tone="dark">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Your Leads Are Already Coming In. Make Sure They Don&apos;t Disappear.
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-slate-300">
          Contractor Growth Co. builds the system that turns more of those opportunities into booked work.
        </p>
        <div className="mt-9 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <CtaLink href="/get-started">Get Started</CtaLink>
          <CtaLink href="/how-it-works" variant="secondaryDark">
            See How It Works
          </CtaLink>
        </div>
      </div>
    </Section>
  );
}
