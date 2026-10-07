import Link from "next/link";
import { segmentedItemClass, segmentedTrackClass } from "@/lib/ui/segmented";
import type { PeopleView } from "@/lib/people/filter";

/**
 * Batch 2: People is one destination - the old Contacts and Leads sidebar
 * entries become its two views, switched here (the same segmented control
 * Money's tabs use). The views are the existing filterPeople views; nothing
 * about who appears in each changed.
 */
export function PeopleViews({ active, everyoneLabel }: { active: PeopleView; everyoneLabel: string }) {
  const items: { value: PeopleView; label: string; href: string }[] = [
    { value: "all", label: everyoneLabel, href: "/people" },
    { value: "leads", label: "Leads", href: "/people?view=leads" },
  ];

  return (
    <div className={segmentedTrackClass} role="group" aria-label="People view">
      {items.map((item) => (
        <Link key={item.value} href={item.href} aria-pressed={active === item.value} className={segmentedItemClass(active === item.value)}>
          {item.label}
        </Link>
      ))}
    </div>
  );
}
