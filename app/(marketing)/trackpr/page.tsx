import type { Metadata } from "next";
import { Hero } from "../_components/home/hero";
import { Problem } from "../_components/home/problem";
import { Solution } from "../_components/home/solution";
import { WhatWeBuild } from "../_components/home/what-we-build";
import { ProductVisual } from "../_components/home/product-visual";
import { BuiltForContractors } from "../_components/home/built-for-contractors";
import { WhyUs } from "../_components/home/why-us";
import { Roi } from "../_components/home/roi";
import { Offer } from "../_components/home/offer";
import { Faq } from "../_components/home/faq";
import { FinalCta } from "../_components/home/final-cta";

/** The Trackpr marketing home - moved from / to /trackpr when Cinder Revenue Company (the parent brand) took the root. */
export const metadata: Metadata = {
  alternates: { canonical: "/trackpr" },
};

export default function HomePage() {
  return (
    <>
      <Hero />
      <Problem />
      <Solution />
      <WhatWeBuild />
      <ProductVisual />
      <BuiltForContractors />
      <WhyUs />
      <Roi />
      <Offer />
      <Faq />
      <FinalCta />
    </>
  );
}
