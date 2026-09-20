import { Hero } from "./_components/home/hero";
import { Problem } from "./_components/home/problem";
import { Solution } from "./_components/home/solution";
import { HowItWorksPreview } from "./_components/home/how-it-works-preview";
import { WhatWeBuild } from "./_components/home/what-we-build";
import { ProductVisual } from "./_components/home/product-visual";
import { BuiltForContractors } from "./_components/home/built-for-contractors";
import { WhyUs } from "./_components/home/why-us";
import { WhoItsFor } from "./_components/home/who-its-for";
import { Roi } from "./_components/home/roi";
import { Offer } from "./_components/home/offer";
import { Faq } from "./_components/home/faq";
import { FinalCta } from "./_components/home/final-cta";

export default function HomePage() {
  return (
    <>
      <Hero />
      <Problem />
      <Solution />
      <HowItWorksPreview />
      <WhatWeBuild />
      <ProductVisual />
      <BuiltForContractors />
      <WhyUs />
      <WhoItsFor />
      <Roi />
      <Offer />
      <Faq />
      <FinalCta />
    </>
  );
}
