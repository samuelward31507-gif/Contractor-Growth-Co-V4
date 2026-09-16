"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { inputClass } from "@/lib/ui/form";
import { contactDisplayName } from "@/lib/contacts/format";
import { filterContacts, type Contact } from "@/lib/contacts/queries";

export function ContactPicker({
  contacts,
  defaultContact,
  name = "contactId",
}: {
  contacts: Contact[];
  defaultContact?: Pick<Contact, "id" | "first_name" | "last_name"> | null;
  name?: string;
}) {
  const [query, setQuery] = useState(defaultContact ? contactDisplayName(defaultContact) : "");
  const [selectedId, setSelectedId] = useState(defaultContact?.id ?? "");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => filterContacts(contacts, query).slice(0, 8), [contacts, query]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function selectContact(contact: Contact) {
    setSelectedId(contact.id);
    setQuery(contactDisplayName(contact));
    setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative">
      <input type="hidden" name={name} value={selectedId} />
      <input
        type="text"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelectedId("");
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search contacts by name, company, phone, or email"
        autoComplete="off"
        className={inputClass}
      />
      {open && query && results.length > 0 ? (
        <ul className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
          {results.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                onClick={() => selectContact(contact)}
                className="flex w-full flex-col items-start px-3 py-2 text-left text-sm transition-colors hover:bg-slate-50"
              >
                <span className="font-medium text-slate-900">{contactDisplayName(contact)}</span>
                {contact.company_name ? (
                  <span className="text-xs text-slate-500">{contact.company_name}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {open && query && results.length === 0 ? (
        <div className="absolute z-10 mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 shadow-lg">
          No contacts match &quot;{query}&quot;
        </div>
      ) : null}
    </div>
  );
}
