import EstimatesPage from "../estimates/page";
import JobsPage from "../jobs/page";

/**
 * Trackpr 2.0, Phase 0: the smallest safe migration target for the locked
 * Estimates & Jobs destination (/estimates + /jobs -> /work). Not the final
 * unified, stage-visualized surface (Master Product Specification Part 11)
 * - that is Phase 5's job.
 *
 * Dispatches, unchanged, to the real EstimatesPage or JobsPage component
 * based on the `type` query parameter set by next.config.ts's redirect
 * rules (/estimates -> /work?type=estimates, /jobs -> /work?type=jobs).
 * Defaults to Estimates (the earlier stage of the two) for a direct,
 * un-marked visit to /work with no `type` at all.
 */
export default async function WorkPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.searchParams;
  const type = typeof params.type === "string" ? params.type : undefined;

  if (type === "jobs") {
    return JobsPage(props as Parameters<typeof JobsPage>[0]);
  }
  return EstimatesPage(props as Parameters<typeof EstimatesPage>[0]);
}
