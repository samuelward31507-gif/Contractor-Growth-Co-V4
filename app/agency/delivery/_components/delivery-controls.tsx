"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Dialog, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { Badge } from "@/lib/ui/badge";
import { errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass, secondaryButtonSmallClass } from "@/lib/ui/form";
import {
  SERVICE_MODULES,
  SERVICE_MODULE_LABELS,
  TASK_CATEGORIES,
  TASK_CATEGORY_LABELS,
  TASK_STATUS_LABELS,
  type DeliveryClient,
  type DeliveryTask,
  type ReadinessCheck,
  type TaskStatus,
} from "@/lib/agency/delivery";
import type { AdminDirectoryEntry } from "@/lib/agency/delivery-queries";
import { CHECK_LABEL, CHECK_TONE } from "./stage";
import {
  addServices,
  addTask,
  approveLaunch,
  linkOrganization,
  markReadyToLaunch,
  moveToOngoing,
  setClientDetails,
  setTaskDetails,
  setTaskStatus,
  startOnboarding,
  type DeliveryActionResult,
} from "../actions";

/** Runs one action at a time; shows its error; refreshes the page on success. */
function useAction() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  function run(action: () => Promise<DeliveryActionResult>, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onDone?.();
      router.refresh();
    });
  }
  return { isPending, error, run };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-xs font-medium text-danger-text">
      {error}
    </p>
  ) : null;
}

function OwnerSelect({ id, name, admins, defaultValue }: { id: string; name: string; admins: AdminDirectoryEntry[]; defaultValue: string | null }) {
  const known = admins.some((a) => a.userId === defaultValue);
  return (
    <select id={id} name={name} defaultValue={defaultValue ?? ""} className={inputClass}>
      <option value="">No owner</option>
      {defaultValue && !known ? <option value={defaultValue}>Current owner (no longer an agency admin)</option> : null}
      {admins.map((a) => (
        <option key={a.userId} value={a.userId}>
          {a.email}
        </option>
      ))}
    </select>
  );
}

/** Starting onboarding: the modules that were sold decide which tasks are generated. */
export function StartOnboardingForm({ client, admins }: { client: DeliveryClient; admins: AdminDirectoryEntry[] }) {
  const { isPending, error, run } = useAction();
  return (
    <form
      action={(fd) =>
        run(() =>
          startOnboarding(client.id, {
            expectedUpdatedAt: client.updatedAt,
            services: fd.getAll("services").map(String),
            ownerUserId: fd.get("owner"),
            targetLaunchDate: fd.get("target"),
          }),
        )
      }
      className="space-y-4"
    >
      <fieldset>
        <legend className={labelClass}>Service modules sold</legend>
        <p className="text-xs text-ink-3">Choose what was agreed in the scope. The core onboarding tasks are always included; each module adds its own.</p>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SERVICE_MODULES.map((m) => (
            <label key={m} className="flex min-h-9 items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" name="services" value={m} className="h-4 w-4" />
              {SERVICE_MODULE_LABELS[m]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="start-owner" className={labelClass}>Delivery owner</label>
          <OwnerSelect id="start-owner" name="owner" admins={admins} defaultValue={null} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="start-target" className={labelClass}>Target launch date</label>
          <input id="start-target" name="target" type="date" className={inputClass} />
        </div>
      </div>
      <ErrorLine error={error} />
      <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
        {isPending ? "Starting…" : "Start onboarding"}
      </button>
    </form>
  );
}

/** Adding a module sold later. Only adds tasks; nothing is ever removed. */
export function AddServicesForm({ client }: { client: DeliveryClient }) {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const remaining = SERVICE_MODULES.filter((m) => !client.services.includes(m));
  if (!remaining.length) return null;
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={secondaryButtonSmallClass}>
        Add a module
      </button>
    );
  return (
    <form action={(fd) => run(() => addServices(client.id, { expectedUpdatedAt: client.updatedAt, services: fd.getAll("services").map(String) }), () => setOpen(false))} className="space-y-2">
      <p className="text-xs text-ink-3">Adding a module adds its tasks and is recorded in the history. Modules and their tasks can&rsquo;t be removed.</p>
      {remaining.map((m) => (
        <label key={m} className="flex min-h-9 items-center gap-2 text-sm text-ink-2">
          <input type="checkbox" name="services" value={m} className="h-4 w-4" />
          {SERVICE_MODULE_LABELS[m]}
        </label>
      ))}
      <ErrorLine error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
          {isPending ? "Adding…" : "Add modules"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={ghostButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ClientDetailsForm({ client, admins }: { client: DeliveryClient; admins: AdminDirectoryEntry[] }) {
  const { isPending, error, run } = useAction();
  return (
    <form action={(fd) => run(() => setClientDetails(client.id, { expectedUpdatedAt: client.updatedAt, ownerUserId: fd.get("owner"), targetLaunchDate: fd.get("target") }))} className="space-y-3">
      <div className="space-y-1.5">
        <label htmlFor="client-owner" className={labelClass}>Delivery owner</label>
        <OwnerSelect id="client-owner" name="owner" admins={admins} defaultValue={client.ownerUserId} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="client-target" className={labelClass}>Target launch date</label>
        <input id="client-target" name="target" type="date" defaultValue={client.targetLaunchDate ?? ""} className={inputClass} />
      </div>
      <ErrorLine error={error} />
      <button type="submit" disabled={isPending} className={secondaryButtonAutoClass}>
        {isPending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

export function MarkReadyButton({ client, gatePasses, reason }: { client: DeliveryClient; gatePasses: boolean; reason: string }) {
  const { isPending, error, run } = useAction();
  return (
    <div className="space-y-1">
      <button type="button" disabled={isPending || !gatePasses} onClick={() => run(() => markReadyToLaunch(client.id, { expectedUpdatedAt: client.updatedAt }))} className={primaryButtonAutoClass}>
        {isPending ? "Saving…" : "Mark ready to launch"}
      </button>
      {!gatePasses ? <p className="text-xs text-ink-3">{reason}</p> : null}
      <ErrorLine error={error} />
    </div>
  );
}

export function MoveToOngoingButton({ client }: { client: DeliveryClient }) {
  const { isPending, error, run } = useAction();
  return (
    <div className="space-y-1">
      <button type="button" disabled={isPending} onClick={() => run(() => moveToOngoing(client.id, { expectedUpdatedAt: client.updatedAt }))} className={secondaryButtonAutoClass}>
        {isPending ? "Saving…" : "Move to ongoing management"}
      </button>
      <ErrorLine error={error} />
    </div>
  );
}

/**
 * Launch approval. Shows the readiness checks as they stand; any Unverified
 * check needs a written acknowledgement. The server recomputes the checks
 * itself - what's shown here is for the admin's review, not trusted.
 */
export function ApproveLaunchButton({ client, checks }: { client: DeliveryClient; checks: ReadinessCheck[] }) {
  const [open, setOpen] = useState(false);
  const blockers = checks.filter((c) => c.status === "failed" && c.critical);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={primaryButtonAutoClass}>
        Review and approve launch
      </button>
      {open ? <ApproveLaunchDialog client={client} checks={checks} blocked={blockers.length > 0} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ApproveLaunchDialog({ client, checks, blocked, onClose }: { client: DeliveryClient; checks: ReadinessCheck[]; blocked: boolean; onClose: () => void }) {
  const { isPending, error, run } = useAction();
  // One request id per open dialog: a double click or retry records one launch.
  const [requestId] = useState(() => crypto.randomUUID());
  const [ack, setAck] = useState("");
  const unverified = checks.filter((c) => c.status === "unverified");
  const needsAck = unverified.length > 0;
  return (
    <Dialog onClose={onClose} labelledBy="approve-launch-title" className="max-h-[90vh] max-w-xl overflow-y-auto">
      <DialogTitle id="approve-launch-title">Approve launch for {client.name}</DialogTitle>
      <div className="mt-4 space-y-4">
        {error ? (
          <p className={errorBannerClass} role="alert">
            {error}
          </p>
        ) : null}
        <p className="text-sm text-ink-2">
          Approving records the launch decision and these checks, and moves the client to Live. It doesn&rsquo;t turn on Go Live in Trackpr, resume automation or send anything.
        </p>
        <ul className="divide-y divide-line rounded-lg border border-line" aria-label="Readiness checks">
          {checks.map((c) => (
            <li key={c.key} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{c.label}</p>
                <p className="break-words text-xs text-ink-3">{c.detail}</p>
              </div>
              <Badge tone={CHECK_TONE[c.status]}>{CHECK_LABEL[c.status]}</Badge>
            </li>
          ))}
        </ul>
        {blocked ? <p className="text-sm font-medium text-danger-text">A critical check failed. Resolve it before launching.</p> : null}
        {needsAck && !blocked ? (
          <div className="space-y-1.5">
            <label htmlFor="launch-ack" className={labelClass}>
              {unverified.length} check{unverified.length === 1 ? " is" : "s are"} unverified. Say why launching anyway is acceptable.
            </label>
            <textarea id="launch-ack" value={ack} onChange={(e) => setAck(e.target.value)} rows={3} maxLength={1000} className={inputClass} placeholder="e.g. Verified the texting number and test lead by hand on the client's phone." />
            <p className="text-xs text-ink-3">Kept with the launch record. At least 10 characters.</p>
          </div>
        ) : null}
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button
            type="button"
            disabled={isPending || blocked || (needsAck && ack.trim().length < 10)}
            onClick={() => run(() => approveLaunch(client.id, { requestId, expectedUpdatedAt: client.updatedAt, acknowledgement: ack }), onClose)}
            className={primaryButtonAutoClass}
          >
            {isPending ? "Approving…" : "Approve launch"}
          </button>
        </DialogFooter>
      </div>
    </Dialog>
  );
}

const NEXT_STATUSES: TaskStatus[] = ["todo", "in_progress", "blocked", "done", "wont_do"];

/** Status, block/skip reason, owner and due date for one task. */
export function TaskControls({ clientId, task, admins }: { clientId: string; task: DeliveryTask; admins: AdminDirectoryEntry[] }) {
  const { isPending, error, run } = useAction();
  const [pending, setPending] = useState<TaskStatus | null>(null);
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState(false);
  const options = NEXT_STATUSES.filter((s) => s !== task.status && !(s === "wont_do" && task.required));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`status-${task.id}`} className="sr-only">
          Change status of {task.title}
        </label>
        <select
          id={`status-${task.id}`}
          value=""
          disabled={isPending}
          onChange={(e) => {
            const next = e.target.value as TaskStatus;
            if (!next) return;
            if (next === "blocked" || next === "wont_do") {
              setPending(next);
              setReason("");
            } else run(() => setTaskStatus(clientId, task.id, { expectedUpdatedAt: task.updatedAt, status: next }));
          }}
          className={`${inputClass} h-9 w-auto text-sm`}
        >
          <option value="">Change status…</option>
          {options.map((s) => (
            <option key={s} value={s}>
              {TASK_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setEditing((v) => !v)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
          {editing ? "Close" : "Owner & due date"}
        </button>
      </div>
      {pending ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`reason-${task.id}`} className="sr-only">
            {pending === "blocked" ? "What is blocking it" : "Why it won't be done"}
          </label>
          <input id={`reason-${task.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder={pending === "blocked" ? "What's blocking it?" : "Why won't it be done?"} className={`${inputClass} h-9 flex-1 text-sm`} />
          <button
            type="button"
            disabled={isPending || !reason.trim()}
            onClick={() => run(() => setTaskStatus(clientId, task.id, { expectedUpdatedAt: task.updatedAt, status: pending, reason }), () => setPending(null))}
            className={secondaryButtonSmallClass}
          >
            {pending === "blocked" ? "Mark blocked" : "Mark won't do"}
          </button>
          <button type="button" onClick={() => setPending(null)} className="min-h-9 rounded-md px-2 text-xs font-medium text-ink-3 hover:bg-inset">
            Cancel
          </button>
        </div>
      ) : null}
      {editing ? (
        <form action={(fd) => run(() => setTaskDetails(clientId, task.id, { expectedUpdatedAt: task.updatedAt, ownerUserId: fd.get("owner"), dueDate: fd.get("due") }), () => setEditing(false))} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
          <div className="space-y-1">
            <label htmlFor={`owner-${task.id}`} className="text-xs text-ink-3">Owner</label>
            <OwnerSelect id={`owner-${task.id}`} name="owner" admins={admins} defaultValue={task.ownerUserId} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`due-${task.id}`} className="text-xs text-ink-3">Due</label>
            <input id={`due-${task.id}`} name="due" type="date" defaultValue={task.dueDate ?? ""} className={inputClass} />
          </div>
          <button type="submit" disabled={isPending} className={secondaryButtonSmallClass}>
            Save
          </button>
        </form>
      ) : null}
      <ErrorLine error={error} />
    </div>
  );
}

export function AddTaskForm({ clientId, admins }: { clientId: string; admins: AdminDirectoryEntry[] }) {
  const { isPending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className={secondaryButtonSmallClass}>
        Add a task
      </button>
    );
  return (
    <form
      action={(fd) =>
        run(
          () =>
            addTask(clientId, {
              requestId,
              title: fd.get("title"),
              description: fd.get("description"),
              category: fd.get("category"),
              required: fd.get("required"),
              waitingOn: fd.get("waitingOn"),
              ownerUserId: fd.get("owner"),
              dueDate: fd.get("due"),
            }),
          () => {
            setOpen(false);
            setRequestId(crypto.randomUUID());
          },
        )
      }
      className="space-y-3 rounded-lg border border-line p-3"
    >
      <div className="space-y-1.5">
        <label htmlFor="task-title" className={labelClass}>Task</label>
        <input id="task-title" name="title" required maxLength={200} className={inputClass} />
      </div>
      <div className="space-y-1.5">
        <label htmlFor="task-description" className={labelClass}>Details (optional)</label>
        <textarea id="task-description" name="description" rows={2} maxLength={2000} className={inputClass} />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="task-category" className={labelClass}>Category</label>
          <select id="task-category" name="category" defaultValue="other" className={inputClass}>
            {TASK_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {TASK_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="task-waiting" className={labelClass}>Waiting on</label>
          <select id="task-waiting" name="waitingOn" defaultValue="agency" className={inputClass}>
            <option value="agency">The Agency</option>
            <option value="client">The client</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="task-owner" className={labelClass}>Owner</label>
          <OwnerSelect id="task-owner" name="owner" admins={admins} defaultValue={null} />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="task-due" className={labelClass}>Due</label>
          <input id="task-due" name="due" type="date" className={inputClass} />
        </div>
      </div>
      <label className="flex min-h-9 items-center gap-2 text-sm text-ink-2">
        <input type="checkbox" name="required" className="h-4 w-4" />
        Required before launch
      </label>
      <ErrorLine error={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
          {isPending ? "Adding…" : "Add task"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={ghostButtonClass}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Explicitly link an Agency-managed Trackpr account. Only accounts already managed by the Agency are offered (and accepted). */
export function LinkAccountForm({ client, organizations }: { client: DeliveryClient; organizations: { organizationId: string; organizationName: string }[] }) {
  const { isPending, error, run } = useAction();
  const [confirming, setConfirming] = useState<string | null>(null);
  if (!organizations.length) return <p className="text-xs text-ink-3">No unlinked Agency-managed Trackpr accounts. An account must already be managed by the Agency before it can be linked here.</p>;
  const chosen = organizations.find((o) => o.organizationId === confirming);
  return (
    <div className="space-y-2">
      {chosen ? (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="text-sm text-ink-2">
            Link <span className="font-semibold text-ink">{chosen.organizationName}</span> to {client.name}? This is recorded, can&rsquo;t be changed here afterwards, and doesn&rsquo;t change anything in the Trackpr account.
          </p>
          <div className="flex gap-2">
            <button type="button" disabled={isPending} onClick={() => run(() => linkOrganization(client.id, { expectedUpdatedAt: client.updatedAt, organizationId: chosen.organizationId }), () => setConfirming(null))} className={primaryButtonAutoClass}>
              {isPending ? "Linking…" : "Link account"}
            </button>
            <button type="button" onClick={() => setConfirming(null)} className={ghostButtonClass}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <form action={(fd) => setConfirming(String(fd.get("organization") ?? "") || null)} className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <label htmlFor="link-org" className="text-xs text-ink-3">Agency-managed Trackpr account</label>
            <select id="link-org" name="organization" required className={inputClass}>
              <option value="">Choose…</option>
              {organizations.map((o) => (
                <option key={o.organizationId} value={o.organizationId}>
                  {o.organizationName}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className={secondaryButtonAutoClass}>
            Continue
          </button>
        </form>
      )}
      <ErrorLine error={error} />
    </div>
  );
}
