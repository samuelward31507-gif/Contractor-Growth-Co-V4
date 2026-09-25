"use client";

import Link from "next/link";
import { useState } from "react";
import type { Appointment } from "@/lib/appointments/queries";
import type { BlockedTime } from "@/lib/scheduling/blocked-time";
import { formatAppointmentTime } from "@/lib/appointments/format";
import { contactDisplayName } from "@/lib/contacts/format";
import { APPOINTMENT_STATUS_TONE } from "../../appointments/_components/status";
import { RAIL_TONE_CLASS } from "@/lib/ui/badge";
import type { DateParts } from "../_lib/date-range";
import { formatDateOnly } from "../_lib/date-range";
import { AppointmentDetailDialog } from "./appointment-detail-dialog";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Pass 2 (Native Calendar System, Phase 3): the Month view. Deliberately
 * summarized (a handful of chips per day, "+N more" beyond that) per this
 * pass's own "do not overload the month view with tiny unreadable
 * appointment cards" instruction - a day with real detail belongs in Day
 * view, one click away via this exact day's cell.
 */
export function MonthView({
  gridDays,
  currentMonth,
  appointments,
  blockedTime,
  timeZone,
  todayKey,
  dayHref,
}: {
  gridDays: DateParts[];
  currentMonth: number;
  appointments: Appointment[];
  blockedTime: BlockedTime[];
  timeZone?: string;
  todayKey: string;
  dayHref: (date: DateParts) => string;
}) {
  const [openAppointment, setOpenAppointment] = useState<Appointment | null>(null);

  function dayKey(iso: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  }

  const appointmentsByDay = new Map<string, Appointment[]>();
  for (const appointment of appointments) {
    const key = dayKey(appointment.start_at);
    const list = appointmentsByDay.get(key) ?? [];
    list.push(appointment);
    appointmentsByDay.set(key, list);
  }

  const blockedCountByDay = new Map<string, number>();
  for (const block of blockedTime) {
    const key = dayKey(block.start_at);
    blockedCountByDay.set(key, (blockedCountByDay.get(key) ?? 0) + 1);
  }

  const MAX_CHIPS = 3;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="grid grid-cols-7 border-b border-slate-100 bg-slate-50">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {gridDays.map((date) => {
          const key = formatDateOnly(date);
          const dayAppointments = (appointmentsByDay.get(key) ?? []).sort((a, b) => a.start_at.localeCompare(b.start_at));
          const blockedCount = blockedCountByDay.get(key) ?? 0;
          const isCurrentMonth = date.month === currentMonth;
          const isToday = key === todayKey;
          const overflow = dayAppointments.length - MAX_CHIPS;

          return (
            <div key={key} className={`flex min-h-[104px] flex-col gap-1 border-b border-r border-slate-100 p-1.5 last:border-r-0 ${isCurrentMonth ? "bg-white" : "bg-slate-50/50"}`}>
              <div className="flex items-center justify-between">
                <Link
                  href={dayHref(date)}
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium transition-colors hover:bg-slate-100 ${
                    isToday ? "bg-accent text-accent-foreground hover:bg-accent-strong" : isCurrentMonth ? "text-slate-700" : "text-slate-400"
                  }`}
                >
                  {date.day}
                </Link>
                {blockedCount > 0 ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" title={`${blockedCount} blocked period${blockedCount > 1 ? "s" : ""}`} /> : null}
              </div>

              <div className="flex flex-col gap-1">
                {dayAppointments.slice(0, MAX_CHIPS).map((appointment) => {
                  const name = appointment.contact ? contactDisplayName(appointment.contact) : "No contact";
                  return (
                    <button
                      key={appointment.id}
                      type="button"
                      onClick={() => setOpenAppointment(appointment)}
                      className={`truncate rounded border-l-2 bg-slate-50 px-1.5 py-0.5 text-left text-[11px] font-medium text-slate-700 hover:bg-slate-100 ${RAIL_TONE_CLASS[APPOINTMENT_STATUS_TONE[appointment.status]]}`}
                    >
                      {formatAppointmentTime(appointment.start_at, timeZone)} {name}
                    </button>
                  );
                })}
                {overflow > 0 ? (
                  <Link href={dayHref(date)} className="px-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-900">
                    +{overflow} more
                  </Link>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {openAppointment ? <AppointmentDetailDialog appointment={openAppointment} timeZone={timeZone} onClose={() => setOpenAppointment(null)} /> : null}
    </div>
  );
}
