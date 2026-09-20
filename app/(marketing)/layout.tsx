import type { Metadata } from "next";
import type { ReactNode } from "react";
import { MarketingNav } from "./_components/marketing-nav";
import { MarketingFooter } from "./_components/marketing-footer";

const SITE_URL = "https://contractor-growth-co-v4.vercel.app";
const TITLE = "Contractor Growth Co. | Turn More Leads Into Booked Jobs";
const DESCRIPTION =
  "Contractor Growth Co. builds and manages the lead response, follow-up, and business-tracking system behind your contracting business — so the leads you're already paying for actually turn into booked jobs.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: "%s | Contractor Growth Co.",
  },
  description: DESCRIPTION,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Contractor Growth Co.",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
  },
};

// Only fields we can state accurately - no fabricated address, phone,
// ratings, or reviews (schema.org AggregateRating/review would be a false
// claim we have no data to back).
const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Contractor Growth Co.",
  url: SITE_URL,
  description: DESCRIPTION,
};

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-white">
      {/* Static, hardcoded JSON-LD above - no user input. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD) }} />
      <MarketingNav />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
