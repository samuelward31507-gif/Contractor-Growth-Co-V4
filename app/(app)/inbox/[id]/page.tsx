import { redirect } from "next/navigation";

/**
 * Trackpr 2.0, Phase 1 (Inbox route gap fix): see ../page.tsx's own header
 * comment for the full rationale - identical reasoning applies here. The
 * dynamic id is forwarded byte-for-byte; any query parameters are preserved
 * the same way ../page.tsx preserves them.
 */
export default async function InboxDetailRedirect(props: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await props.params;
  const params = await props.searchParams;
  const nextParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") nextParams.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) nextParams.set(key, value[0]);
  }
  const query = nextParams.toString();
  redirect(query ? `/conversations/${id}?${query}` : `/conversations/${id}`);
}
