/** Renders inside the Activity timeline panel, which supplies the surface and border. */
export function ActivityEmptyState() {
  return (
    <div className="flex items-center justify-center px-2 py-12">
      <div className="max-w-sm text-center">
        <p className="text-sm font-medium text-ink">No activity yet.</p>
        <p className="mt-1.5 text-sm text-ink-3">
          Activity will appear here as you and your team use Trackpr - things like new contacts, lead updates, and
          appointment changes.
        </p>
      </div>
    </div>
  );
}
