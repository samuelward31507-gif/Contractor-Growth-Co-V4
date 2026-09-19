"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import { AppointmentDialog } from "../../_components/appointment-dialog";
import { DeleteAppointmentDialog } from "./delete-appointment-dialog";

export function AppointmentActions({
  appointment,
  contacts,
  leads,
}: {
  appointment: Appointment;
  contacts: Contact[];
  leads: Lead[];
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => setEditOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
      >
        <Pencil aria-hidden className="h-4 w-4" />
        Edit
      </button>
      <button
        type="button"
        onClick={() => setDeleteOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg border border-red-200 px-3.5 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
      >
        <Trash2 aria-hidden className="h-4 w-4" />
        Delete
      </button>

      {editOpen ? (
        <AppointmentDialog
          mode="edit"
          appointment={appointment}
          contacts={contacts}
          leads={leads}
          onClose={() => {
            setEditOpen(false);
            router.refresh();
          }}
        />
      ) : null}
      {deleteOpen ? (
        <DeleteAppointmentDialog appointment={appointment} onClose={() => setDeleteOpen(false)} />
      ) : null}
    </div>
  );
}
