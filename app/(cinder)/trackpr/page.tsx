import type { Metadata } from "next";
import { TALK_HREF } from "../_components/content";
import { TrackprAvailability, TrackprCta, TrackprHero, TrackprLifecycle, TrackprProductShowcase, TrackprQuestions } from "../_components/trackpr-product";

const TITLE = "Trackpr — The first revenue operating system from Cinder";
const DESCRIPTION =
  "Trackpr shows what is happening with your revenue, what needs attention and what should happen next - from the first lead to the final payment. A product of Cinder Revenue Company, available today for contractors and the trades.";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: "/trackpr" },
  openGraph: {
    type: "website",
    url: "/trackpr",
    siteName: "Cinder Revenue Company",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// The product, and who makes it - no ratings, offers or prices.
const PRODUCT_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Trackpr",
  applicationCategory: "BusinessApplication",
  description: DESCRIPTION,
  publisher: { "@type": "Organization", name: "Cinder Revenue Company" },
};

/** Trackpr - Cinder's flagship product, presented on the Cinder site. */
export default function TrackprPage() {
  return (
    <>
      {/* Static, hardcoded JSON-LD above - no user input. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(PRODUCT_JSON_LD) }} />
      <TrackprHero />
      <TrackprProductShowcase />
      <TrackprQuestions />
      <TrackprLifecycle />
      <TrackprAvailability />
      <TrackprCta talkHref={TALK_HREF} />
    </>
  );
}
