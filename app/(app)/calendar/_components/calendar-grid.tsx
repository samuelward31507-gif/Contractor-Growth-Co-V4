"use client";

import { useState } from "react";
import type { Contact } from "@/lib/contacts/queries";
import type { Lead } from "@/lib/leads/queries";
import type { Appointment } from "@/lib/appointments/queries";
import type { BlockedTime } from "@/lib/scheduling/blocked-time";
import { contactDisplayName } from "@/lib/contacts/format";
import { formatAppointmentTime } from "@/lib/appointments/format";
import { APPOINTMENT_STATUS_TONE } from "../../appointments/_components/status";
import { RAIL_TONE_CLASS } from "@/lib/ui/badge";
import type { DateParts } from "../_lib/date-range";
import { formatDateOnly } from "../_lib/date-range";
import { HOUR_HEIGHT_PX, localMinutesSinceMidnight, computeBlockPosition, type GridBounds } from "../_lib/grid";
import { AppointmentDialog } from "../../appointments/_components/appointment-dialog";
import { AppointmentDetailDialog } from "./appointment-detail-dialog";
import { BlockedTimeDialog } from "./blocked-time-dialog";

function dayKey(iso: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatHourLabel(hour: number): string {
  const h = hour % 24;
  const period = h < 12 ? "AM" : "PM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${period}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Pass 2 (Native Calendar System, Phase 3): the shared time-grid renderer
 * for both the Day view (1 column) and Week view (7 columns) - the same
 * grid mechanics, parameterized by how many day columns to render, so
 * there is exactly one implementation of "position appointments/blocked
 * time on an hour grid" rather than two near-duplicate ones.
 */
export function CalendarGrid({
  days,
  bounds,
  appointments,
  blockedTime,
  contacts,
  leads,
  timeZone,
  defaultDurationMinutes,
  todayKey,
}: {
  days: DateParts[];
  bounds: GridBounds;
  appointments: Appointment[];
  blockedTime: BlockedTime[];
  contacts: Contact[];
  leads: Lead[];
  timeZone?: string;
  defaultDurationMinutes: number;
  /** The REAL current organization-local date ("YYYY-MM-DD"), server-computed - used only to decide which column gets the current-time indicator, never to make an availability decision. */
  todayKey: string;
}) {
  const [openAppointment, setOpenAppointment] = useState<Appointment | null>(null);
  const [openBlockedTime, setOpenBlockedTime] = useState<BlockedTime | null>(null);
  const [createPrefill, setCreatePrefill] = useState<{ date: string; startTime: string; endTime: string } | null>(null);

  const hours: number[] = [];
  for (let h = bounds.startHour; h < bounds.endHour; h++) hours.push(h);
  const gridHeight = (bounds.endHour - bounds.startHour) * HOUR_HEIGHT_PX;

  const appointmentsByDay = new Map<string, Appointment[]>();
  for (const appointment of appointments) {
    const key = dayKey(appointment.start_at, timeZone);
    const list = appointmentsByDay.get(key) ?? [];
    list.push(appointment);
    appointmentsByDay.set(key, list);
  }

  const blockedByDay = new Map<string, BlockedTime[]>();
  for (const block of blockedTime) {
    const key = dayKey(block.start_at, timeZone);
    const list = blockedByDay.get(key) ?? [];
    list.push(block);
    blockedByDay.set(key, list);
  }

  function openCreateAt(date: DateParts, hour: number) {
    const startTime = `${pad(hour)}:00`;
    const endMinutes = hour * 60 + defaultDurationMinutes;
    const endTime = `${pad(Math.min(23, Math.floor(endMinutes / 60)))}:${pad(endMinutes % 60)}`;
    setCreatePrefill({ date: formatDateOnly(date), startTime, endTime });
  }

  return (
    <div className="flex overflow-x-auto rounded-xl border border-slate-200 bg-white">
      {/* Hour gutter */}
      <div className="sticky left-0 z-10 w-16 shrink-0 border-r border-slate-100 bg-white">
        <div className="h-10 border-b border-slate-100" />
        {hours.map((hour) => (
          <div key={hour} style={{ height: HOUR_HEIGHT_PX }} className="relative border-b border-slate-50 text-right">
            <span className="absolute -top-2 right-2 text-[11px] font-medium text-slate-400">{formatHourLabel(hour)}</span>
          </div>
        ))}
      </div>

      {days.map((date) => {
        const key = formatDateOnly(date);
        const dayAppointments = appointmentsByDay.get(key) ?? [];
        const dayBlocks = blockedByDay.get(key) ?? [];
        const isToday = key === todayKey;

        return (
          <div key={key} className="min-w-[160px] flex-1 border-r border-slate-100 last:border-r-0">
            <div className={`flex h-10 items-center justify-center border-b border-slate-100 text-sm font-medium ${isToday ? "text-accent-text" : "text-slate-600"}`}>
              {new Intl.DateTimeFormat("en-US", { timeZone, weekday: days.length > 1 ? "short" : "long", month: "short", day: "numeric" }).format(
                new Date(Date.UTC(date.year, date.month - 1, date.day, 12)),
              )}
            </div>
            <div className="relative" style={{ height: gridHeight }}>
              {hours.map((hour, index) => (
                <button
                  key={hour}
                  type="button"
                  onClick={() => openCreateAt(date, hour)}
                  aria-label={`Add appointment at ${formatHourLabel(hour)}`}
                  style={{ top: index * HOUR_HEIGHT_PX, height: HOUR_HEIGHT_PX }}
                  className="absolute left-0 right-0 border-b border-slate-50 transition-colors hover:bg-slate-50"
                />
              ))}

              {isToday
                ? (() => {
                    const nowMinutes = localMinutesSinceMidnight(new Date().toISOString(), timeZone);
                    if (nowMinutes < bounds.startHour * 60 || nowMinutes > bounds.endHour * 60) return null;
                    const top = (nowMinutes - bounds.startHour * 60) * (HOUR_HEIGHT_PX / 60);
                    return (
                      <div className="pointer-events-none absolute left-0 right-0 z-20 border-t-2 border-red-500" style={{ top }}>
                        <span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-red-500" />
                      </div>
                    );
                  })()
                : null}

              {dayBlocks.map((block) => {
                const start = localMinutesSinceMidnight(block.start_at, timeZone);
                const end = localMinutesSinceMidnight(block.end_at, timeZone);
                const position = computeBlockPosition(start, end, bounds);
                return (
                  <button
                    key={block.id}
                    type="button"
                    onClick={() => setOpenBlockedTime(block)}
                    style={{ top: position.topPx, height: position.heightPx }}
                    className="absolute left-1 right-1 z-10 overflow-hidden rounded-md bg-[repeating-linear-gradient(135deg,theme(colors.slate.200),theme(colors.slate.200)_6px,theme(colors.slate.100)_6px,theme(colors.slate.100)_12px)] px-2 py-1 text-left text-xs font-medium text-slate-600 shadow-sm ring-1 ring-inset ring-slate-300 hover:ring-slate-400"
                  >
                    {block.reason || "Blocked"}
                  </button>
                );
              })}

              {dayAppointments.map((appointment) => {
                const start = localMinutesSinceMidnight(appointment.start_at, timeZone);
                const end = localMinutesSinceMidnight(appointment.end_at, timeZone);
                const position = computeBlockPosition(start, end, bounds);
                const name = appointment.contact ? contactDisplayName(appointment.contact) : "No contact";
                return (
                  <button
                    key={appointment.id}
                    type="button"
                    onClick={() => setOpenAppointment(appointment)}
                    style={{ top: position.topPx, height: position.heightPx }}
                    className={`absolute left-1 right-1 z-10 overflow-hidden rounded-md border-l-2 bg-white px-2 py-1 text-left text-xs shadow-sm ring-1 ring-inset ring-slate-200 transition-shadow hover:shadow-md ${RAIL_TONE_CLASS[APPOINTMENT_STATUS_TONE[appointment.status]]}`}
                  >
                    <span className="block truncate font-semibold text-slate-900">
                      {formatAppointmentTime(appointment.start_at, timeZone)} · {name}
                    </span>
                    <span className="block truncate text-slate-500">{appointment.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {openAppointment ? <AppointmentDetailDialog appointment={openAppointment} timeZone={timeZone} onClose={() => setOpenAppointment(null)} /> : null}
      {openBlockedTime ? <BlockedTimeDialog mode="edit" blockedTime={openBlockedTime} timeZone={timeZone} onClose={() => setOpenBlockedTime(null)} /> : null}
      {createPrefill ? (
        <AppointmentDialog
          mode="create"
          contacts={contacts}
          leads={leads}
          defaultDate={createPrefill.date}
          defaultStartTime={createPrefill.startTime}
          defaultEndTime={createPrefill.endTime}
          onClose={() => setCreatePrefill(null)}
        />
      ) : null}
    </div>
  );
}
