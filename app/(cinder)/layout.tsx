import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { CinderNav } from "./_components/nav";
import { CinderFooter } from "./_components/footer";
import { SITE_URL, TALK_HREF } from "./_components/content";

const TITLE = "Cinder Revenue Company | Revenue Systems";
const DESCRIPTION =
  "Cinder builds revenue systems that turn more opportunities into revenue - connecting every step from the first lead to the final payment. Trackpr is its first revenue operating system.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: TITLE, template: "%s | Cinder Revenue Company" },
  description: DESCRIPTION,
  applicationName: "Cinder",
  icons: {
    icon: [{ url: "/brand/cinder-app-icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/brand/cinder-app-icon.svg" }],
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Cinder Revenue Company",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#f5f3ee",
};

// Only facts we can state: who the company is and what it makes.
const ORGANIZATION_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Cinder Revenue Company",
  alternateName: "Cinder",
  url: SITE_URL,
  logo: `${SITE_URL}/brand/cinder-mark.svg`,
  description: DESCRIPTION,
  brand: { "@type": "Brand", name: "Trackpr" },
};

/**
 * Cinder Revenue Company - the parent-brand website at /. Its own route
 * group holds every public marketing page - the Cinder home, the Trackpr
 * product page, the intake form and the legal pages - so none inherits the
 * authenticated application shell.
 */
export default function CinderLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col bg-cinder-canvas text-cinder-ink [font-feature-settings:'ss01','cv11']">
      {/* Static, hardcoded JSON-LD above - no user input. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ORGANIZATION_JSON_LD) }} />
      {/* Without JavaScript, reveal-on-scroll content is shown immediately. */}
      <noscript>
        <style>{`.cinder-reveal{opacity:1!important;transform:none!important}`}</style>
      </noscript>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-cinder-ink focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-cinder-on-night"
      >
        Skip to content
      </a>
      <CinderNav talkHref={TALK_HREF} />
      <main id="main" className="flex-1">
        {children}
      </main>
      <CinderFooter />
    </div>
  );
}
