import {
  Globe,
  Inbox,
  Zap,
  Brain,
  Repeat,
  CalendarCheck2,
  FileText,
  RotateCcw,
  Users2,
  Star,
  LineChart,
  HeartPulse,
  type LucideIcon,
} from "lucide-react";
import { Section, SectionHeading } from "../section";

const BUILD_ITEMS: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: Globe, title: "Contractor website", description: "A website designed to turn visitors into inquiries." },
  { icon: Inbox, title: "Lead capture", description: "Every inquiry organized into one system." },
  { icon: Zap, title: "Instant lead response", description: "Fast response when new opportunities arrive." },
  { icon: Brain, title: "AI-assisted qualification", description: "Incoming conversations can be analyzed and routed appropriately." },
  { icon: Repeat, title: "Automated follow-up", description: "Leads and estimates don't simply disappear." },
  { icon: CalendarCheck2, title: "Appointment management", description: "Keep scheduled opportunities organized." },
  { icon: FileText, title: "Estimate follow-up", description: "Stay in front of customers after estimates are sent." },
  { icon: RotateCcw, title: "Lost lead nurture", description: "Continue working opportunities that didn't close immediately." },
  { icon: Users2, title: "Reactivation", description: "Reconnect with older leads and customers." },
  { icon: Star, title: "Reviews + referrals", description: "Create a repeatable post-job process." },
  { icon: LineChart, title: "Business analytics", description: "Understand pipeline, activity, appointments, estimates, jobs, and system performance." },
  { icon: HeartPulse, title: "Automation health", description: "Know when something needs attention." },
];

export function WhatWeBuild() {
  return (
    <Section>
      <SectionHeading
        eyebrow="What we build"
        title="We Build the System. You Run Your Business."
        description="Contractor Growth Co. handles the technical setup — you focus on the work."
      />

      <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {BUILD_ITEMS.map((item) => (
          <div key={item.title} className="flex items-start gap-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700">
              <item.icon className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-slate-900">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-500">{item.description}</p>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}
