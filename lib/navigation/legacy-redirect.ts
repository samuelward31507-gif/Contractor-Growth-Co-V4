/**
 * Batch 2 (navigation, shell & information architecture): where a retired
 * list route sends its visitor. Every incoming query parameter is carried
 * over (a filter, a search, a `?new=estimate&contactId=...` deep link), the
 * first value of a repeated one, and then `set` is applied on top - it
 * names the destination's own view, so a stale param of the same name can
 * never point the visitor somewhere else. Pure, so the redirects are
 * testable without a server.
 */
export type IncomingParams = Record<string, string | string[] | undefined>;

export function legacyRedirectTarget(pathname: string, params: IncomingParams, set: Record<string, string> = {}): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key in set) continue;
    if (typeof value === "string") next.set(key, value);
    else if (Array.isArray(value) && value[0] !== undefined) next.set(key, value[0]);
  }
  for (const [key, value] of Object.entries(set)) next.set(key, value);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}
