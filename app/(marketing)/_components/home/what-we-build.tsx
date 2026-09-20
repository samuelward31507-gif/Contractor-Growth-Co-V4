import { Globe, Zap, Brain, Repeat, CalendarCheck2, RotateCcw, Star, LineChart, type LucideIcon } from "lucide-react";
import { Section, SectionHeading } from "../section";

const BUILD_ITEMS: { icon: LucideIcon; title: string; description: string }[] = [
  { icon: Globe, title: "Lead Capture", description: "A website and intake built to turn visitors and inquiries into organized opportunities, not lost tabs." },
  { icon: Zap, title: "Instant Response", description: "New leads get a fast response instead of sitting untouched while a prospect calls someone else." },
  { icon: Brain, title: "AI Qualification", description: "Incoming conversations get reviewed so the right opportunities surface instead of getting buried." },
  { icon: Repeat, title: "Follow-Up", description: "Leads and open estimates get followed up with on a schedule, instead of quietly going cold." },
  { icon: CalendarCheck2, title: "Appointment Flow", description: "Booked appointments and sent estimates stay visible and organized from first contact to close." },
  { icon: RotateCcw, title: "Reactivation", description: "Older leads and past customers get reconnected with instead of being forgotten after one job." },
  { icon: Star, title: "Reviews & Referrals", description: "A completed job automatically creates the opening to ask for a review and a referral." },
  { icon: LineChart, title: "Revenue Tracking", description: "Pipeline, follow-up, and job activity are visible in one place instead of scattered across tools." },
];

export function WhatWeBuild() {
  return (
    <Section>
      <SectionHeading
        eyebrow="What we build"
        title="We Build the System. You Run Your Business."
        description="Eight connected pieces, not eight separate tools — each one a part of the same system shown above."
      />

      <div className="mt-14 grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {BUILD_ITEMS.map((item) => (
          <div key={item.title}>
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-700">
              <item.icon className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <p className="mt-4 text-[15px] font-semibold text-slate-900">{item.title}</p>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-500">{item.description}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
