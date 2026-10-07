import { FileText, Send, CircleDollarSign, CheckCircle2, Ban } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { InvoiceStatus } from "@/lib/invoices/domain";
import { STATUS_LABEL } from "@/lib/ui/status-vocabulary";

/** Maps each invoice status onto the shared <Badge> primitive's tone + icon (the estimates/_components/status.ts pattern). */
export const INVOICE_STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  draft: "neutral",
  sent: "info",
  partially_paid: "warning",
  paid: "success",
  void: "neutral",
};

export const INVOICE_STATUS_ICON: Record<InvoiceStatus, LucideIcon> = {
  draft: FileText,
  sent: Send,
  partially_paid: CircleDollarSign,
  paid: CheckCircle2,
  void: Ban,
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  draft: STATUS_LABEL.draft,
  sent: STATUS_LABEL.sent,
  partially_paid: STATUS_LABEL.partiallyPaid,
  paid: STATUS_LABEL.paid,
  void: STATUS_LABEL.void,
};

export const INVOICE_STATUS_OPTIONS: { value: InvoiceStatus; label: string }[] = (Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatus[]).map((value) => ({ value, label: INVOICE_STATUS_LABELS[value] }));
