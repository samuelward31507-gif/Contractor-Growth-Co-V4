"use client";

import { useActionState, useState } from "react";
import { Pencil, Trash2, Plus } from "lucide-react";
import { secondaryButtonAutoClass } from "@/lib/ui/form";
import { metaClass, subsectionTitleClass } from "@/lib/ui/typography";
import type { Service } from "@/lib/settings/queries";
import { toggleServiceActive, type DeleteState } from "../actions";
import { DeleteServiceDialog } from "./delete-service-dialog";
import { ServiceDialog } from "./service-dialog";

const initialToggleState: DeleteState = {};

function ServiceRow({
  service,
  canEdit,
  onEdit,
  onDelete,
}: {
  service: Service;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [state, toggleAction, isPending] = useActionState(toggleServiceActive, initialToggleState);

  return (
    <li className="flex flex-col gap-2 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{service.name}</p>
        {service.description ? (
          <p className="mt-0.5 truncate text-xs text-slate-500">{service.description}</p>
        ) : null}
        {state.error ? <p className="mt-1 text-xs text-danger-text">{state.error}</p> : null}
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <form action={toggleAction}>
          <input type="hidden" name="id" value={service.id} />
          <input type="hidden" name="isActive" value={(!service.is_active).toString()} />
          <button
            type="submit"
            disabled={!canEdit || isPending}
            className="inline-flex items-center gap-1.5 rounded-md text-sm text-slate-600 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10 disabled:cursor-not-allowed"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${service.is_active ? "bg-emerald-500" : "bg-slate-300"}`} aria-hidden />
            {isPending ? "Updating…" : service.is_active ? "Active" : "Inactive"}
          </button>
        </form>

        {canEdit ? (
          <>
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit service"
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-900/10"
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete service"
              className="flex h-8 w-8 items-center justify-center rounded-md text-red-500 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/20"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </>
        ) : null}
      </div>
    </li>
  );
}

export function ServicesSection({ services, canEdit }: { services: Service[]; canEdit: boolean }) {
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [deleting, setDeleting] = useState<Service | null>(null);

  return (
    <section>
      <div className="flex items-center justify-between">
        <div>
          <h2 className={subsectionTitleClass}>Services</h2>
          <p className={`mt-1 ${metaClass}`}>Services your business provides.</p>
        </div>
        {canEdit ? (
          <button type="button" onClick={() => setAddOpen(true)} className={secondaryButtonAutoClass}>
            <Plus className="h-4 w-4" aria-hidden />
            Add service
          </button>
        ) : null}
      </div>

      {services.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No services yet. Add the services your business offers so future AI systems can reference them.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {services.map((service) => (
            <ServiceRow
              key={service.id}
              service={service}
              canEdit={canEdit}
              onEdit={() => setEditing(service)}
              onDelete={() => setDeleting(service)}
            />
          ))}
        </ul>
      )}

      {addOpen ? <ServiceDialog mode="create" onClose={() => setAddOpen(false)} /> : null}
      {editing ? <ServiceDialog mode="edit" service={editing} onClose={() => setEditing(null)} /> : null}
      {deleting ? <DeleteServiceDialog service={deleting} onClose={() => setDeleting(null)} /> : null}
    </section>
  );
}
