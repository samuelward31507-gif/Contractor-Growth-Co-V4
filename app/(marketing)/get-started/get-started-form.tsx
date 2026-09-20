"use client";

import { useState, type FormEvent } from "react";
import { Mail } from "lucide-react";
import { buildMailtoUrl } from "@/lib/site/contact";

const TRADES = [
  "HVAC",
  "Plumbing",
  "Electrical",
  "Roofing",
  "Remodeling",
  "Concrete",
  "Landscaping",
  "Painting",
  "Flooring",
  "Other",
];

const LEAD_VOLUMES = ["Fewer than 10", "10–25", "25–50", "50–100", "100+"];

const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 shadow-sm transition-colors focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-900/10";
const labelClass = "text-sm font-medium text-slate-700";

/**
 * There is no lead-capture backend anywhere in this repository (no contact
 * API route, no email service, no public-facing inquiries table - the
 * existing `leads` table is per-tenant and RLS-protected, meaning nothing
 * for an anonymous visitor to write into) and the build scope for this site
 * forbids inventing one (fake webhook, fake email service, schema changes).
 * This form is fully real and validated, but its "submit" is an honest
 * hand-off to email (see lib/site/contact.ts) rather than a fabricated
 * success state claiming the data was received by a system that doesn't
 * exist.
 */
export function GetStartedForm() {
  const [sent, setSent] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const get = (key: string) => (form.get(key) as string)?.trim() || "—";

    const body = [
      `Business name: ${get("businessName")}`,
      `Contact name: ${get("name")}`,
      `Phone: ${get("phone")}`,
      `Email: ${get("email")}`,
      `Trade: ${get("trade")}`,
      `Website: ${get("website")}`,
      `Approximate monthly lead volume: ${get("leadVolume")}`,
      "",
      "Biggest challenge:",
      get("challenge"),
    ].join("\n");

    window.location.href = buildMailtoUrl({
      subject: `Growth system inquiry — ${get("businessName")}`,
      body,
    });
    setSent(true);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-6 sm:p-8">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="name" className={labelClass}>
            Name
          </label>
          <input id="name" name="name" type="text" required className={inputClass} placeholder="Your name" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="businessName" className={labelClass}>
            Business name
          </label>
          <input id="businessName" name="businessName" type="text" required className={inputClass} placeholder="Your company" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="phone" className={labelClass}>
            Phone
          </label>
          <input id="phone" name="phone" type="tel" required className={inputClass} placeholder="(555) 123-4567" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="email" className={labelClass}>
            Email
          </label>
          <input id="email" name="email" type="email" required className={inputClass} placeholder="you@company.com" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="trade" className={labelClass}>
            Trade
          </label>
          <select id="trade" name="trade" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Select your trade
            </option>
            {TRADES.map((trade) => (
              <option key={trade} value={trade}>
                {trade}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="website" className={labelClass}>
            Website (if you have one)
          </label>
          <input id="website" name="website" type="text" className={inputClass} placeholder="yourbusiness.com" />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="leadVolume" className={labelClass}>
            Approximate monthly lead volume
          </label>
          <select id="leadVolume" name="leadVolume" defaultValue="" className={inputClass}>
            <option value="" disabled>
              Select a range
            </option>
            {LEAD_VOLUMES.map((range) => (
              <option key={range} value={range}>
                {range}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="challenge" className={labelClass}>
            Biggest challenge right now
          </label>
          <textarea
            id="challenge"
            name="challenge"
            rows={3}
            className={`${inputClass} resize-none`}
            placeholder="e.g. estimates go unanswered, missed calls, no time to follow up..."
          />
        </div>
      </div>

      <button
        type="submit"
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-6 py-3.5 text-[15px] font-semibold text-white shadow-sm transition-colors hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600"
      >
        <Mail className="h-4 w-4" aria-hidden />
        Send This to Us
      </button>

      <p className="text-center text-xs text-slate-500" role="status">
        {sent
          ? "Your email app should now be open with this information filled in — send it over and we'll follow up."
          : "This opens an email to our team with your answers filled in. Nothing is submitted automatically."}
      </p>
    </form>
  );
}
