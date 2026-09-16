import { Icon } from "../../_components/icon";

export function ConversationsEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Icon name="conversations" className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-slate-900">No conversations yet</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Conversations will appear here once customers reach out or your team logs an
          interaction with a contact.
        </p>
      </div>
    </div>
  );
}
