"use client";

import { RouteError } from "@/lib/ui/route-error";

export default function OnboardingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} homeHref="/onboarding" homeLabel="Back to Getting Started" />;
}
