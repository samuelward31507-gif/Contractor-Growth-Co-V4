export function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <p className="text-sm font-medium text-slate-900">No client organizations are currently connected.</p>
      <p className="mt-1.5 text-sm text-slate-500">Once a client organization is associated with the agency, it will appear here.</p>
    </div>
  );
}
