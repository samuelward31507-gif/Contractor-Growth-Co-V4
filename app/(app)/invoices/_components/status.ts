import { FileText, Send, CircleDollarSign, CheckCircle2, Ban } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { BadgeTone } from "@/lib/ui/badge";
import type { InvoiceStatus } from "@/lib/invoices/domain";

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
  draft: "Draft",
  sent: "Sent",
  partially_paid: "Partially paid",
  paid: "Paid",
  void: "Void",
};

export const INVOICE_STATUS_OPTIONS: { value: InvoiceStatus; label: string }[] = (Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatus[]).map((value) => ({ value, label: INVOICE_STATUS_LABELS[value] }));
