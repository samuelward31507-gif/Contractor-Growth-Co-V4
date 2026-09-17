"use client";

import { useActionState, useState } from "react";
import { cardClass, cardHeaderClass, cardSubtleClass, cardTitleClass } from "@/lib/ui/card";
import { Icon } from "../../_components/icon";
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
    <li className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-900">{service.name}</p>
        {service.description ? (
          <p className="mt-0.5 truncate text-xs text-slate-500">{service.description}</p>
        ) : null}
        {state.error ? <p className="mt-1 text-xs text-red-600">{state.error}</p> : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <form action={toggleAction}>
          <input type="hidden" name="id" value={service.id} />
          <input type="hidden" name="isActive" value={(!service.is_active).toString()} />
          <button
            type="submit"
            disabled={!canEdit || isPending}
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
              service.is_active
                ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                : "bg-slate-100 text-slate-500 hover:bg-slate-200"
            }`}
          >
            {isPending ? "Updating…" : service.is_active ? "Active" : "Inactive"}
          </button>
        </form>

        {canEdit ? (
          <>
            <button
              type="button"
              onClick={onEdit}
              aria-label="Edit service"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-100"
            >
              <Icon name="pencil" className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              aria-label="Delete service"
              className="flex h-8 w-8 items-center justify-center rounded-lg text-red-500 transition-colors hover:bg-red-50"
            >
              <Icon name="trash" className="h-4 w-4" />
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
    <section className={cardClass}>
      <div className={cardHeaderClass}>
        <div>
          <h2 className={cardTitleClass}>Services</h2>
          <p className={`mt-0.5 ${cardSubtleClass}`}>Services your business provides.</p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
          >
            <Icon name="plus" className="h-4 w-4" />
            Add Service
          </button>
        ) : null}
      </div>

      {services.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-medium text-slate-900">No services yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Add the services your business offers so future AI systems can reference them.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
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
