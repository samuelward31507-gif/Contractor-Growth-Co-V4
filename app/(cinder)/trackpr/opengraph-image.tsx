import { ImageResponse } from "next/og";
import { CINDER_MARK_EMBER, CINDER_MARK_RING } from "@/lib/cinder/brand-paths";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Trackpr - the first revenue operating system from Cinder Revenue Company.";

const QUESTIONS = ["What is happening with my revenue?", "What needs attention?", "What should I do next?"];

/**
 * The Trackpr share card - the product name, its place in Cinder, and the
 * questions it answers, in the Cinder palette. No screenshots, no figures.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 80px", backgroundColor: "#0f1a17", color: "#f2f0ea", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 26, color: "rgba(242,240,234,0.75)" }}>
          <svg width={44} height={44} viewBox="0 0 48 48">
            <path fill="#f2f0ea" d={CINDER_MARK_RING} />
            <path fill="#e58c63" d={CINDER_MARK_EMBER} />
          </svg>
          <div style={{ display: "flex" }}>Cinder Revenue Company</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <div style={{ display: "flex", width: 76, height: 76, borderRadius: 18, backgroundColor: "#e58c63", color: "#0f1a17", alignItems: "center", justifyContent: "center", fontSize: 44, fontWeight: 700 }}>T</div>
            <div style={{ display: "flex", fontSize: 96, fontWeight: 700, letterSpacing: "-0.05em", lineHeight: 1 }}>Trackpr</div>
          </div>
          <div style={{ display: "flex", marginTop: 26, fontSize: 40, fontWeight: 600, letterSpacing: "-0.02em", color: "rgba(242,240,234,0.88)" }}>The first revenue operating system from Cinder.</div>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          {QUESTIONS.map((q) => (
            <div key={q} style={{ display: "flex", padding: "9px 16px", borderRadius: 999, fontSize: 20, color: "rgba(242,240,234,0.75)", backgroundColor: "rgba(242,240,234,0.07)" }}>
              {q}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
