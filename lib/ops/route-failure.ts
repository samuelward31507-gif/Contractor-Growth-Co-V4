import { reportOpsAlert, type OpsAlertContext } from "./alert";

/**
 * Batch 4 (production operations hardening): a server route that fails must
 * leave one searchable, structured operator signal - not only a free-text
 * console line. Wraps a route handler; when it answers 5xx or throws, ONE
 * `trackpr_ops_alert` log line is written (lib/ops/alert.ts: sanitized
 * context, never throws) and the original response or error is passed
 * through untouched - the route's contract, status codes and retry behavior
 * are exactly what they were.
 *
 * Log-only (never emailed): these routes run every few minutes, so email
 * here would be a storm; the low-frequency scheduler watchdog and the
 * health tick's own alerts remain the paging path.
 *
 * The context carries only the HTTP method, the path (never the query
 * string), the status, the error's type (never its message) and the
 * platform request id when present - no body, no headers, no customer data.
 */
export type RouteHandler<Req extends Request = Request> = (request: Req) => Promise<Response>;

export type RouteFailureDeps = { report?: typeof reportOpsAlert };

function requestContext(request: Request): OpsAlertContext {
  let path = "";
  try {
    path = new URL(request.url).pathname;
  } catch {
    path = "";
  }
  return { method: request.method, path, requestId: request.headers.get("x-vercel-id") ?? request.headers.get("x-request-id") ?? null };
}

export function withOpsFailureReporting<Req extends Request>(source: string, handler: RouteHandler<Req>, deps: RouteFailureDeps = {}): RouteHandler<Req> {
  const report = deps.report ?? reportOpsAlert;
  return async (request: Req) => {
    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      await report({
        severity: "critical",
        source,
        code: "route_threw",
        message: "A server route threw before answering; the caller received a server error.",
        context: { ...requestContext(request), errorType: error instanceof Error ? error.name : typeof error },
      });
      throw error;
    }
    if (response.status >= 500) {
      await report({
        severity: "warning",
        source,
        code: "route_server_error",
        message: "A server route answered with a server error; see the route's own log line for the operation.",
        context: { ...requestContext(request), status: response.status },
      });
    }
    return response;
  };
}
