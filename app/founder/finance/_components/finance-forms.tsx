"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Dialog, DialogDescription, DialogFooter, DialogTitle } from "@/lib/ui/dialog";
import { destructiveButtonAutoClass, errorBannerClass, ghostButtonClass, inputClass, labelClass, primaryButtonAutoClass, secondaryButtonAutoClass, secondaryButtonSmallClass } from "@/lib/ui/form";
import { CADENCES, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, INCOME_KINDS, INCOME_KIND_LABELS, RECEIVED_VIA, RECEIVED_VIA_LABELS, type CashBalance, type Expense, type IncomeReceipt, type RecurringCost } from "@/lib/founder/finance";
import {
  correctFounderExpense,
  correctFounderIncome,
  correctFounderRecurringCost,
  createFounderRecurringCost,
  endFounderRecurringCost,
  markFounderExpensePaid,
  recordFounderCashBalance,
  recordFounderExpense,
  recordFounderIncome,
  recordRecurringCostPayment,
  voidFounderFinanceRecord,
  type FinanceActionResult,
} from "../actions";

/**
 * Founder finance forms. Each dialog makes a request id when it opens - the
 * database uses it as the new record's id, so a double-click or a retry after
 * a dropped response returns "duplicate" instead of recording twice. Edits
 * carry the record's updated_at as it was loaded; if it changed since, the
 * database refuses and the dialog says to reopen.
 */

type Submit = (fields: Record<string, unknown>) => Promise<FinanceActionResult>;

function newRequestId(): string {
  return crypto.randomUUID();
}

/** The shared dialog shell: validation errors inline, a success line on save, then a refresh. */
function FormDialog({ title, description, submitLabel, onClose, onSaved, submit, children, wide = true }: { title: string; description?: ReactNode; submitLabel: string; onClose: () => void; onSaved?: (text: string) => void; submit: Submit; children: ReactNode; wide?: boolean }) {
  const router = useRouter();
  const titleId = useId();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(formData: FormData) {
    const fields = Object.fromEntries(formData.entries());
    setError(null);
    startTransition(async () => {
      const result = await submit(fields);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onSaved?.(result.status === "duplicate" ? "Already saved - nothing was recorded twice." : "Saved.");
      router.refresh();
      onClose();
    });
  }

  return (
    <Dialog onClose={onClose} labelledBy={titleId} className={wide ? "max-w-lg" : ""}>
      <DialogTitle id={titleId}>{title}</DialogTitle>
      {description ? <DialogDescription>{description}</DialogDescription> : null}
      {/* onSubmit, not action=: a form action resets every field when it finishes, which would wipe what was typed whenever a save is refused. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!isPending) onSubmit(new FormData(event.currentTarget));
        }}
        className="mt-4 space-y-3"
        noValidate
      >
        {error ? (
          <p className={errorBannerClass} role="alert">
            {error}
          </p>
        ) : null}
        {children}
        <DialogFooter>
          <button type="button" onClick={onClose} className={ghostButtonClass}>
            Cancel
          </button>
          <button type="submit" disabled={isPending} className={primaryButtonAutoClass}>
            {isPending ? "Saving…" : submitLabel}
          </button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** The confirmation left beside the button after a dialog saves. */
function useSavedNote(): [ReactNode, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  const note = text ? (
    <span role="status" className="text-xs font-medium text-accent-text">
      {text}
    </span>
  ) : null;
  return [note, setText];
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className={labelClass}>
        {label}
      </label>
      {children}
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

function CategorySelect({ id, defaultValue }: { id: string; defaultValue?: string }) {
  return (
    <select id={id} name="category" required defaultValue={defaultValue ?? "software"} className={inputClass}>
      {EXPENSE_CATEGORIES.map((category) => (
        <option key={category} value={category}>
          {EXPENSE_CATEGORY_LABELS[category]}
        </option>
      ))}
    </select>
  );
}

function CurrencyInput({ id, defaultValue, readOnly }: { id: string; defaultValue?: string; readOnly?: boolean }) {
  return <input id={id} name="currency" required maxLength={3} defaultValue={defaultValue ?? "USD"} readOnly={readOnly} autoCapitalize="characters" className={`${inputClass} uppercase`} />;
}

function ReasonField({ id }: { id: string }) {
  return (
    <Field label="Why is this being corrected?" htmlFor={id} hint="Required. Kept in the record's history with the before and after.">
      <textarea id={id} name="reason" required maxLength={500} rows={2} className={inputClass} />
    </Field>
  );
}

function OpenButton({ label, onClick, variant = "primary" }: { label: string; onClick: () => void; variant?: "primary" | "secondary" | "row" }) {
  if (variant === "row") {
    return (
      <button type="button" onClick={onClick} className={secondaryButtonSmallClass}>
        {label}
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} className={variant === "primary" ? primaryButtonAutoClass : secondaryButtonAutoClass}>
      {variant === "primary" ? <Plus className="h-4 w-4" aria-hidden /> : null}
      {label}
    </button>
  );
}

// --- expenses ------------------------------------------------------------------------------

/** Record a new expense, or correct one (with a reason). Paid/unpaid is a choice; a paid expense needs its paid date. */
export function ExpenseDialogButton({ todayKey, expense, label }: { todayKey: string; expense?: Expense; label?: string }) {
  const [savedNote, setSaved] = useSavedNote();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [status, setStatus] = useState<"paid" | "unpaid">(expense ? (expense.paidOn ? "paid" : "unpaid") : "paid");
  const id = useId();
  const correcting = Boolean(expense);
  const linked = Boolean(expense?.recurringCostId);

  function show() {
    setRequestId(newRequestId());
    setStatus(expense ? (expense.paidOn ? "paid" : "unpaid") : "paid");
    setOpen(true);
  }

  const submit: Submit = (fields) =>
    expense ? correctFounderExpense(expense.id, { ...fields, status, expectedUpdatedAt: expense.updatedAt }) : recordFounderExpense({ ...fields, status, requestId });

  return (
    <>
      <OpenButton label={label ?? (correcting ? "Correct" : "Record expense")} onClick={show} variant={correcting ? "row" : "primary"} />
      {savedNote}
      {open ? (
        <FormDialog onSaved={setSaved}
          title={correcting ? "Correct expense" : "Record expense"}
          description={correcting ? "Fix what was entered. The original stays in the history." : "Counted on the date it's paid (cash basis). Record an unpaid bill now and mark it paid later."}
          submitLabel={correcting ? "Save correction" : "Record expense"}
          onClose={() => setOpen(false)}
          submit={submit}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vendor" htmlFor={`${id}-vendor`}>
              <input id={`${id}-vendor`} name="vendor" required maxLength={200} defaultValue={expense?.vendor} className={inputClass} />
            </Field>
            <Field label="Category" htmlFor={`${id}-category`}>
              <CategorySelect id={`${id}-category`} defaultValue={expense?.category} />
            </Field>
            <Field label="Amount" htmlFor={`${id}-amount`}>
              <input id={`${id}-amount`} name="amount" required inputMode="decimal" defaultValue={expense?.amount} placeholder="0.00" className={`${inputClass} tabular-nums`} />
            </Field>
            <Field label="Currency" htmlFor={`${id}-currency`} hint={linked ? "Fixed by the recurring cost." : undefined}>
              <CurrencyInput id={`${id}-currency`} defaultValue={expense?.currency} readOnly={linked} />
            </Field>
            <Field label="Expense date" htmlFor={`${id}-incurred`}>
              <input id={`${id}-incurred`} name="incurredOn" type="date" required defaultValue={expense?.incurredOn ?? todayKey} className={inputClass} />
            </Field>
            <Field label="Due date (optional)" htmlFor={`${id}-due`}>
              <input id={`${id}-due`} name="dueOn" type="date" defaultValue={expense?.dueOn ?? ""} className={inputClass} />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className={labelClass}>Payment status</legend>
            <div className="flex flex-wrap gap-4 text-sm text-ink-2">
              {(["paid", "unpaid"] as const).map((value) => (
                <label key={value} className="flex min-h-11 items-center gap-2 sm:min-h-0">
                  <input type="radio" name={`${id}-status`} checked={status === value} onChange={() => setStatus(value)} className="h-4 w-4 accent-[var(--color-accent)]" />
                  {value === "paid" ? "Paid" : "Not paid yet"}
                </label>
              ))}
            </div>
          </fieldset>
          {status === "paid" ? (
            <Field label="Date paid" htmlFor={`${id}-paid`} hint="Not in the future. A payment made before the expense date (a prepayment) is fine.">
              <input id={`${id}-paid`} name="paidOn" type="date" required max={todayKey} defaultValue={expense?.paidOn ?? todayKey} className={inputClass} />
            </Field>
          ) : null}
          <Field label="Description (optional)" htmlFor={`${id}-description`}>
            <input id={`${id}-description`} name="description" maxLength={500} defaultValue={expense?.description ?? ""} className={inputClass} />
          </Field>
          {correcting ? <ReasonField id={`${id}-reason`} /> : null}
        </FormDialog>
      ) : null}
    </>
  );
}

export function MarkPaidButton({ expense, todayKey }: { expense: Expense; todayKey: string }) {
  const [savedNote, setSaved] = useSavedNote();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <OpenButton label="Mark paid" onClick={() => setOpen(true)} variant="row" />
      {savedNote}
      {open ? (
        <FormDialog onSaved={setSaved} title={`Mark ${expense.vendor} paid`} description="It will count as spent on this date." submitLabel="Mark paid" onClose={() => setOpen(false)} submit={(fields) => markFounderExpensePaid(expense.id, { ...fields, expectedUpdatedAt: expense.updatedAt })} wide={false}>
          <Field label="Date paid" htmlFor={`${id}-paid`}>
            <input id={`${id}-paid`} name="paidOn" type="date" required max={todayKey} defaultValue={todayKey} className={inputClass} />
          </Field>
        </FormDialog>
      ) : null}
    </>
  );
}

// --- recurring costs -----------------------------------------------------------------------------

export function RecurringCostDialogButton({ todayKey, cost }: { todayKey: string; cost?: RecurringCost }) {
  const [savedNote, setSaved] = useSavedNote();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState("");
  const id = useId();
  const correcting = Boolean(cost);
  const submit: Submit = (fields) => (cost ? correctFounderRecurringCost(cost.id, { ...fields, expectedUpdatedAt: cost.updatedAt }) : createFounderRecurringCost({ ...fields, requestId }));
  return (
    <>
      <OpenButton
        label={correcting ? "Correct" : "Add recurring cost"}
        onClick={() => {
          setRequestId(newRequestId());
          setOpen(true);
        }}
        variant={correcting ? "row" : "primary"}
      />
      {savedNote}
      {open ? (
        <FormDialog onSaved={setSaved}
          title={correcting ? "Correct recurring cost" : "Add recurring cost"}
          description={correcting ? "Vendor, category and description only. If the price changes, end this cost and add a new one, so past months keep their real amount." : "A commitment you pay every month or year. Record each actual payment against it."}
          submitLabel={correcting ? "Save correction" : "Add recurring cost"}
          onClose={() => setOpen(false)}
          submit={submit}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vendor" htmlFor={`${id}-vendor`}>
              <input id={`${id}-vendor`} name="vendor" required maxLength={200} defaultValue={cost?.vendor} className={inputClass} />
            </Field>
            <Field label="Category" htmlFor={`${id}-category`}>
              <CategorySelect id={`${id}-category`} defaultValue={cost?.category} />
            </Field>
            {correcting ? null : (
              <>
                <Field label="Amount per period" htmlFor={`${id}-amount`}>
                  <input id={`${id}-amount`} name="amount" required inputMode="decimal" placeholder="0.00" className={`${inputClass} tabular-nums`} />
                </Field>
                <Field label="Currency" htmlFor={`${id}-currency`}>
                  <CurrencyInput id={`${id}-currency`} />
                </Field>
                <Field label="Billed" htmlFor={`${id}-cadence`}>
                  <select id={`${id}-cadence`} name="cadence" required defaultValue="monthly" className={inputClass}>
                    {CADENCES.map((cadence) => (
                      <option key={cadence} value={cadence}>
                        {cadence === "monthly" ? "Monthly" : "Annually"}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Starts" htmlFor={`${id}-start`}>
                  <input id={`${id}-start`} name="startOn" type="date" required defaultValue={todayKey} className={inputClass} />
                </Field>
              </>
            )}
          </div>
          <Field label="Description (optional)" htmlFor={`${id}-description`}>
            <input id={`${id}-description`} name="description" maxLength={500} defaultValue={cost?.description ?? ""} className={inputClass} />
          </Field>
          {correcting ? <ReasonField id={`${id}-reason`} /> : null}
        </FormDialog>
      ) : null}
    </>
  );
}

export function EndRecurringCostButton({ cost, todayKey }: { cost: RecurringCost; todayKey: string }) {
  const [savedNote, setSaved] = useSavedNote();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <OpenButton label="End" onClick={() => setOpen(true)} variant="row" />
      {savedNote}
      {open ? (
        <FormDialog onSaved={setSaved} title={`End ${cost.vendor}`} description="The cost stops counting as a commitment after this date. Past payments stay as recorded." submitLabel="End cost" onClose={() => setOpen(false)} submit={(fields) => endFounderRecurringCost(cost.id, { ...fields, expectedUpdatedAt: cost.updatedAt })} wide={false}>
          <Field label="Last day" htmlFor={`${id}-end`}>
            <input id={`${id}-end`} name="endOn" type="date" required min={cost.startOn} defaultValue={todayKey} className={inputClass} />
          </Field>
        </FormDialog>
      ) : null}
    </>
  );
}

export function RecordRecurringPaymentButton({ cost, todayKey, defaultMonth }: { cost: RecurringCost; todayKey: string; defaultMonth: string }) {
  const [savedNote, setSaved] = useSavedNote();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState("");
  const id = useId();
  return (
    <>
      <OpenButton
        label="Record payment"
        onClick={() => {
          setRequestId(newRequestId());
          setOpen(true);
        }}
        variant="row"
      />
      {savedNote}
      {open ? (
        <FormDialog onSaved={setSaved} title={`Record ${cost.vendor} payment`} description={`One payment per month. Recorded as a paid ${cost.currency} expense.`} submitLabel="Record payment" onClose={() => setOpen(false)} submit={(fields) => recordRecurringCostPayment(cost.id, { ...fields, requestId })} wide={false}>
          <Field label="Month it covers" htmlFor={`${id}-month`}>
            <input id={`${id}-month`} name="coversMonth" type="month" required defaultValue={defaultMonth.slice(0, 7)} className={inputClass} />
          </Field>
          <Field label={`Amount paid (${cost.currency})`} htmlFor={`${id}-amount`} hint="What was actually charged - it can differ from the usual amount.">
            <input id={`${id}-amount`} name="amount" required inputMode="decimal" defaultValue={cost.amount} className={`${inputClass} tabular-nums`} />
          </Field>
          <Field label="Date paid" htmlFor={`${id}-paid`}>
            <input id={`${id}-paid`} name="paidOn" type="date" required max={todayKey} defaultValue={todayKey} className={inputClass} />
          </Field>
        </FormDialog>
      ) : null}
    </>
  );
}

// --- income outside Stripe --------------------------------------------------------------------------

export function IncomeDialogButton({ todayKey, receipt }: { todayKey: string; receipt?: IncomeReceipt }) {
  const [savedNote, setSaved] = useSavedNote();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState("");
  const id = useId();
  const correcting = Boolean(receipt);
  const submit: Submit = (fields) => (receipt ? correctFounderIncome(receipt.id, { ...fields, expectedUpdatedAt: receipt.updatedAt }) : recordFounderIncome({ ...fields, requestId }));
  return (
    <>
      <OpenButton
        label={correcting ? "Correct" : "Record income"}
        onClick={() => {
          setRequestId(newRequestId());
          setOpen(true);
        }}
        variant={correcting ? "row" : "primary"}
      />
      {savedNote}
      {open ? (
        <FormDialog onSaved={setSaved}
          title={correcting ? "Correct manual income" : "Record income received outside Stripe"}
          description={correcting ? "Fix what was entered. The original stays in the history." : "Bank transfers, checks and cash only. Stripe payments are recorded automatically - never enter them here."}
          submitLabel={correcting ? "Save correction" : "Record income"}
          onClose={() => setOpen(false)}
          submit={submit}
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Payer" htmlFor={`${id}-payer`}>
              <input id={`${id}-payer`} name="payer" required maxLength={200} defaultValue={receipt?.payer} className={inputClass} />
            </Field>
            <Field label="For" htmlFor={`${id}-kind`}>
              <select id={`${id}-kind`} name="kind" required defaultValue={receipt?.kind ?? "recurring_fee"} className={inputClass}>
                {INCOME_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {INCOME_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Amount" htmlFor={`${id}-amount`}>
              <input id={`${id}-amount`} name="amount" required inputMode="decimal" defaultValue={receipt?.amount} placeholder="0.00" className={`${inputClass} tabular-nums`} />
            </Field>
            <Field label="Currency" htmlFor={`${id}-currency`}>
              <CurrencyInput id={`${id}-currency`} defaultValue={receipt?.currency} />
            </Field>
            <Field label="Received on" htmlFor={`${id}-received`}>
              <input id={`${id}-received`} name="receivedOn" type="date" required max={todayKey} defaultValue={receipt?.receivedOn ?? todayKey} className={inputClass} />
            </Field>
            <Field label="Received via" htmlFor={`${id}-via`}>
              <select id={`${id}-via`} name="receivedVia" required defaultValue={receipt?.receivedVia ?? "bank_transfer"} className={inputClass}>
                {RECEIVED_VIA.map((via) => (
                  <option key={via} value={via}>
                    {RECEIVED_VIA_LABELS[via]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Reference (optional)" htmlFor={`${id}-reference`} hint="A check number or bank reference.">
            <input id={`${id}-reference`} name="reference" maxLength={200} defaultValue={receipt?.reference ?? ""} className={inputClass} />
          </Field>
          <Field label="Description (optional)" htmlFor={`${id}-description`}>
            <input id={`${id}-description`} name="description" maxLength={500} defaultValue={receipt?.description ?? ""} className={inputClass} />
          </Field>
          {correcting ? <ReasonField id={`${id}-reason`} /> : null}
        </FormDialog>
      ) : null}
    </>
  );
}

// --- cash balances -------------------------------------------------------------------------------------

/** A balance as the statement showed it. Append-only: to fix one, record the right balance and void the wrong one. */
export function CashBalanceDialogButton({ todayKey, account, label }: { todayKey: string; account?: Pick<CashBalance, "accountLabel" | "currency">; label?: string }) {
  const [savedNote, setSaved] = useSavedNote();
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState("");
  const id = useId();
  return (
    <>
      <OpenButton
        label={label ?? "Record balance"}
        onClick={() => {
          setRequestId(newRequestId());
          setOpen(true);
        }}
        variant={account ? "row" : "primary"}
      />
      {savedNote}
      {open ? (
        <FormDialog onSaved={setSaved} title="Record a cash balance" description="What the account statement showed on a date. It may be negative if the account is overdrawn." submitLabel="Record balance" onClose={() => setOpen(false)} submit={(fields) => recordFounderCashBalance({ ...fields, requestId })}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Account" htmlFor={`${id}-account`}>
              <input id={`${id}-account`} name="accountLabel" required maxLength={100} defaultValue={account?.accountLabel} placeholder="Business checking" className={inputClass} />
            </Field>
            <Field label="Currency" htmlFor={`${id}-currency`}>
              <CurrencyInput id={`${id}-currency`} defaultValue={account?.currency} />
            </Field>
            <Field label="Balance" htmlFor={`${id}-balance`}>
              <input id={`${id}-balance`} name="balance" required inputMode="decimal" placeholder="0.00" className={`${inputClass} tabular-nums`} />
            </Field>
            <Field label="Statement date" htmlFor={`${id}-asof`}>
              <input id={`${id}-asof`} name="asOf" type="date" required max={todayKey} defaultValue={todayKey} className={inputClass} />
            </Field>
          </div>
          <Field label="Note (optional)" htmlFor={`${id}-note`}>
            <input id={`${id}-note`} name="note" maxLength={500} className={inputClass} />
          </Field>
        </FormDialog>
      ) : null}
    </>
  );
}

// --- void ------------------------------------------------------------------------------------------------

export function VoidRecordButton({ entity, id, label }: { entity: "expense" | "recurring_cost" | "income" | "cash_balance"; id: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const titleId = useId();
  const reasonId = useId();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`${ghostButtonClass} !min-h-8 px-2 text-xs text-ink-3 hover:text-danger-text`}>
        Void
      </button>
      {open ? (
        <Dialog onClose={() => setOpen(false)} labelledBy={titleId}>
          <DialogTitle id={titleId}>Void {label}?</DialogTitle>
          <DialogDescription>For a record entered in error. It stops counting everywhere but is never deleted - it stays visible, struck through, with your reason.</DialogDescription>
          {error ? (
            <p className={`${errorBannerClass} mt-3`} role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-3 space-y-1.5">
            <label htmlFor={reasonId} className={labelClass}>
              Reason
            </label>
            <textarea id={reasonId} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} rows={2} className={inputClass} />
          </div>
          <DialogFooter>
            <button type="button" onClick={() => setOpen(false)} className={ghostButtonClass}>
              Keep
            </button>
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  const result = await voidFounderFinanceRecord(entity, id, reason);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                  router.refresh();
                })
              }
              className={destructiveButtonAutoClass}
            >
              {isPending ? "Voiding…" : "Void record"}
            </button>
          </DialogFooter>
        </Dialog>
      ) : null}
    </>
  );
}
