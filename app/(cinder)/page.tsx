import type { Metadata } from "next";
import { Company, FinalCta, Hero, Industries, Platform, Problem, Trackpr, WhyCinder } from "./_components/sections";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/** Cinder Revenue Company - the parent-brand home. */
export default function CinderHome() {
  return (
    <>
      <Hero />
      <Problem />
      <Platform />
      <Trackpr />
      <WhyCinder />
      <Industries />
      <Company />
      <FinalCta />
    </>
  );
}
