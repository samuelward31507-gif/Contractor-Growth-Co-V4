import type { Metadata } from "next";
import { DemoShell } from "./_components/demo-shell";

/**
 * Public, read-only interactive sales demo - a fixed, static "Summit Home
 * Services" account for sales meetings. Deliberately outside the (app)
 * route group so it never inherits that layout's auth/session/payment
 * redirects (see app/(app)/layout.tsx) - this route requires no login and
 * touches no backend, database, or integration.
 */
export const metadata: Metadata = {
  title: "Interactive Demo — Trackpr",
  description: "See what running your business through Trackpr looks like, with a realistic example account.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function DemoPage() {
  return <DemoShell />;
}
