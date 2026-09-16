import Link from "next/link";
import { cardClass, cardHeaderClass, cardTitleClass } from "@/lib/ui/card";
import { Icon, type IconName } from "../../_components/icon";

const ACTIONS: { href: string; label: string; icon: IconName }[] = [
  { href: "/leads", label: "Add Lead", icon: "leads" },
  { href: "/contacts", label: "Add Contact", icon: "contacts" },
  { href: "/appointments", label: "Schedule Appointment", icon: "appointments" },
  { href: "/estimates", label: "Create Estimate", icon: "estimates" },
];

export function QuickActions() {
  return (
    <div className={cardClass}>
      <div className={cardHeaderClass}>
        <h2 className={cardTitleClass}>Quick Actions</h2>
      </div>
      <div className="grid grid-cols-2 gap-3 p-5">
        {ACTIONS.map((action) => (
          <Link
            key={action.href}
            href={action.href}
            className="flex flex-col items-start gap-2 rounded-lg border border-slate-200 p-3.5 transition-colors hover:border-slate-300 hover:bg-slate-50"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-700">
              <Icon name={action.icon} className="h-4 w-4" />
            </span>
            <span className="text-sm font-medium text-slate-900">{action.label}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
