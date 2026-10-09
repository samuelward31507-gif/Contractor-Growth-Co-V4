/** Shared test data for the founder model (imported only by *.test.ts). */
import type { FounderDeal } from "./model";

/** Every FounderDeal field with a neutral value; tests override what they exercise. */
export const DEAL_DEFAULTS: Omit<FounderDeal, "id" | "name"> = {
  contactName: null,
  contactEmail: null,
  contactPhone: null,
  source: null,
  trade: null,
  location: null,
  website: null,
  fit: null,
  stage: "identified",
  currency: "USD",
  expectedSetupFee: null,
  expectedMrr: null,
  nextAction: null,
  nextActionAt: null,
  wonSetupFee: null,
  wonMonthlyFee: null,
  wonOn: null,
  lostReason: null,
  lostOn: null,
  enteredStage: null,
  stageChangedAt: null,
  lastActivityAt: null,
  notes: null,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};
