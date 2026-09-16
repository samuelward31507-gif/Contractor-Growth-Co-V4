import { Icon } from "../../_components/icon";
import { AddContactButton } from "./add-contact-button";

export function ContactsEmptyState() {
  return (
    <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-16">
      <div className="max-w-sm text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <Icon name="contacts" className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-slate-900">No contacts yet</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          Contacts are the people and customers connected to your business. Add your first
          contact to start building your directory.
        </p>
        <div className="mt-6 flex justify-center">
          <AddContactButton />
        </div>
      </div>
    </div>
  );
}
