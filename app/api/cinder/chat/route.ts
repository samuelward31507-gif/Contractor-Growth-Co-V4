import type { NextRequest } from "next/server";
import { handleChat } from "@/lib/cinder-chat/handler";

/** POST /api/cinder/chat - the Cinder website assistant. All logic lives in lib/cinder-chat/handler.ts. */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  return handleChat(request);
}
