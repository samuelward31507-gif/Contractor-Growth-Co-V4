"use client";

import { RouteError } from "@/lib/ui/route-error";

export default function AuthCallbackError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} homeHref="/login" homeLabel="Back to Sign In" />;
}
