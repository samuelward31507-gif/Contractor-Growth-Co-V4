// Static, self-contained sales-demo data. Nothing here is fetched, computed
// from Date.now(), or persisted anywhere - every value is a fixed literal so
// the demo looks identical in every sales meeting. This is fictional example
// data only (see the on-page disclosure banner) - it does not represent any
// real customer, contractor, or business.

export type DemoView = "dashboard" | "customers" | "opportunities" | "schedule" | "work" | "growth" | "automations";

export type StageTone = "neutral" | "info" | "success" | "warning" | "danger";

export const DEMO_BUSINESS_NAME = "Summit Home Services";
export const DEMO_DATE_LABEL = "Monday, March 10";

export const DEMO_PIPELINE_VALUE = 42680;

export const DEMO_TOP_METRICS = [
  { label: "New leads", value: "12" },
  { label: "Booked work", value: "$24,850" },
  { label: "Quoted value", value: "$31,420" },
  { label: "Completed work", value: "$18,760" },
];

export const DEMO_SUPPORTING_METRICS = [
  { label: "AI handled", value: "38" },
  { label: "Reviews", value: "14" },
  { label: "Automations", value: "97%" },
];

export type DemoCustomer = {
  id: string;
  name: string;
  service: string;
  stage: string;
  stageTone: StageTone;
  value: number;
  lastActivity: string;
};

export const DEMO_CUSTOMERS: DemoCustomer[] = [
  { id: "michael-torres", name: "Michael Torres", service: "HVAC replacement", stage: "Booked", stageTone: "success", value: 8400, lastActivity: "Job scheduled for tomorrow" },
  { id: "sarah-mitchell", name: "Sarah Mitchell", service: "Water heater", stage: "Estimate sent", stageTone: "info", value: 2850, lastActivity: "Estimate sent 3 days ago" },
  { id: "james-carter", name: "James Carter", service: "AC repair", stage: "New lead", stageTone: "neutral", value: 1200, lastActivity: "Came in this morning" },
  { id: "amanda-brooks", name: "Amanda Brooks", service: "Duct cleaning", stage: "Completed", stageTone: "success", value: 950, lastActivity: "Job completed last week" },
  { id: "robert-davis", name: "Robert Davis", service: "Furnace replacement", stage: "Follow-up", stageTone: "warning", value: 6750, lastActivity: "No activity in 28 days" },
];

export type DemoOpportunity = {
  id: string;
  category: string;
  customer: string;
  value: number;
  reason: string;
};

export const DEMO_OPPORTUNITIES: DemoOpportunity[] = [
  { id: "opp-1", category: "Estimate follow-up", customer: "Sarah Mitchell", value: 2850, reason: "Estimate sent 3 days ago" },
  { id: "opp-2", category: "Dormant customer", customer: "Robert Davis", value: 6750, reason: "No activity in 28 days" },
  { id: "opp-3", category: "Service expansion", customer: "Michael Torres", value: 1900, reason: "Eligible for maintenance plan" },
];

export const DEMO_OPPORTUNITY_TOTAL = DEMO_OPPORTUNITIES.reduce((sum, item) => sum + item.value, 0);

export type DemoAppointment = {
  id: string;
  time: string;
  customer: string;
  service: string;
  status: "Confirmed" | "Pending" | "Open";
};

export const DEMO_TODAY_APPOINTMENTS: DemoAppointment[] = [
  { id: "today-1", time: "10:30 AM", customer: "Michael Torres", service: "HVAC replacement", status: "Confirmed" },
  { id: "today-2", time: "1:00 PM", customer: "Jessica Lee", service: "AC tune-up", status: "Confirmed" },
  { id: "today-3", time: "3:30 PM", customer: "David Wilson", service: "Furnace inspection", status: "Pending" },
];

export const DEMO_NEXT_DAY_LABEL = "Tuesday, March 11";

export const DEMO_NEXT_DAY_APPOINTMENTS: DemoAppointment[] = [
  { id: "next-1", time: "9:00 AM", customer: "Amanda Brooks", service: "Duct cleaning follow-up", status: "Confirmed" },
  { id: "next-2", time: "11:30 AM", customer: "—", service: "Open slot", status: "Open" },
  { id: "next-3", time: "2:00 PM", customer: "Robert Davis", service: "Furnace replacement estimate", status: "Pending" },
];

export type DemoEstimateJob = {
  id: string;
  customer: string;
  service: string;
  stage: string;
  stageTone: StageTone;
  value: number;
  type: "Estimate" | "Job";
};

export const DEMO_ESTIMATE_METRICS = [
  { label: "Open estimates", value: "$31,420" },
  { label: "Accepted", value: "$18,950" },
  { label: "Completed", value: "$18,760" },
];

export const DEMO_ESTIMATES_JOBS: DemoEstimateJob[] = [
  { id: "ej-1", customer: "Michael Torres", service: "HVAC replacement", stage: "Booked", stageTone: "success", value: 8400, type: "Job" },
  { id: "ej-2", customer: "Sarah Mitchell", service: "Water heater replacement", stage: "Estimate sent", stageTone: "info", value: 2850, type: "Estimate" },
  { id: "ej-3", customer: "Robert Davis", service: "Furnace replacement", stage: "Follow-up", stageTone: "warning", value: 6750, type: "Estimate" },
  { id: "ej-4", customer: "Amanda Brooks", service: "Duct cleaning", stage: "Completed", stageTone: "success", value: 950, type: "Job" },
  { id: "ej-5", customer: "Jessica Lee", service: "AC tune-up", stage: "Completed", stageTone: "success", value: 320, type: "Job" },
  { id: "ej-6", customer: "David Wilson", service: "Furnace inspection", stage: "Scheduled", stageTone: "info", value: 240, type: "Job" },
];

export type DemoReview = {
  id: string;
  customer: string;
  rating: number;
  service: string;
  quote: string;
};

export const DEMO_GROWTH_METRICS = [
  { label: "Review requests", value: "14" },
  { label: "Reviews received", value: "9" },
  { label: "Referrals", value: "4" },
];

export const DEMO_REVIEWS: DemoReview[] = [
  { id: "rev-1", customer: "Michael Torres", rating: 5, service: "HVAC replacement", quote: "Fast, professional, and the follow-up texts kept me in the loop the whole time. Would recommend to anyone." },
  { id: "rev-2", customer: "Amanda Brooks", rating: 5, service: "Duct cleaning", quote: "Easiest home service booking I've ever done - the reminder texts meant I never almost missed the appointment." },
  { id: "rev-3", customer: "Karen Lopez", rating: 4, service: "Water heater repair", quote: "Great work and clear communication start to finish. Only reason it's not 5 stars is scheduling took a day longer than hoped." },
];

export const DEMO_AUTOMATION_METRICS = [
  { label: "Healthy", value: "13 / 13" },
  { label: "Executions (30d)", value: "72" },
  { label: "AI handled", value: "38" },
];

export type DemoAutomation = {
  id: string;
  name: string;
  description: string;
};

export const DEMO_AUTOMATIONS: DemoAutomation[] = [
  { id: "auto-1", name: "Instant lead follow-up", description: "Drafts the first reply to a new lead within moments of it coming in." },
  { id: "auto-2", name: "Missed-call recovery", description: "Sends a text the moment a call goes unanswered so no lead goes cold." },
  { id: "auto-3", name: "Estimate follow-up", description: "Checks in automatically while an estimate sits unanswered." },
  { id: "auto-4", name: "Appointment reminders", description: "Confirms upcoming visits and reduces no-shows." },
  { id: "auto-5", name: "Lead reactivation", description: "Re-engages leads who have gone quiet with no booked work." },
  { id: "auto-6", name: "Review request", description: "Asks happy customers for a review right after a completed job." },
  { id: "auto-7", name: "Referral follow-up", description: "Follows up on referral asks after a job wraps up." },
];
