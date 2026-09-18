/**
 * Shown for any signed-in user who is not a recognized agency admin, or who
 * isn't signed in at all if this somehow renders before the layout's
 * redirect. Never renders organization data, counts, or names - the caller
 * must not pass any agency data into this component in the first place.
 */
export function UnauthorizedState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <p className="text-sm font-medium text-slate-900">You don&apos;t have access to the Agency Command Center.</p>
      <p className="mt-1.5 text-sm text-slate-500">This area is restricted to Contractor Growth Co. agency administrators.</p>
    </div>
  );
}
