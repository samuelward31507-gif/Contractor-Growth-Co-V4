import { ImageResponse } from "next/og";
import { CINDER_MARK_EMBER, CINDER_MARK_RING, CINDER_WORDMARK, CINDER_WORDMARK_WIDTH } from "@/lib/cinder/brand-paths";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Cinder Revenue Company - revenue systems that turn more opportunities into revenue.";

const STAGES = ["Lead", "Response", "Qualification", "Appointment", "Proposal", "Delivery", "Payment"];
const PIVOTAL = new Set(["Response", "Proposal", "Payment"]);

/**
 * The Cinder share card - the logo, the positioning line and the lifecycle
 * the company is built around, in the brand's own palette. No screenshots,
 * no figures.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 80px", backgroundColor: "#0f1a17", color: "#f2f0ea", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <svg width={(56 + CINDER_WORDMARK_WIDTH) * 1.1} height={48 * 1.1} viewBox={`0 0 ${56 + CINDER_WORDMARK_WIDTH} 48`}>
            <path fill="#f2f0ea" d={CINDER_MARK_RING} />
            <path fill="#e58c63" d={CINDER_MARK_EMBER} />
            <path fill="#f2f0ea" transform="translate(56 14)" d={CINDER_WORDMARK} />
          </svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 66, fontWeight: 700, letterSpacing: "-0.04em", lineHeight: 1.04, maxWidth: 940 }}>Revenue systems built to turn more opportunities into revenue.</div>
          <div style={{ marginTop: 22, fontSize: 26, color: "rgba(242,240,234,0.68)" }}>From the first lead to the final payment. Trackpr is the first.</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {STAGES.map((stage, i) => (
            <div key={stage} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  display: "flex",
                  padding: "8px 14px",
                  borderRadius: 999,
                  fontSize: 19,
                  color: PIVOTAL.has(stage) ? "#0f1a17" : "rgba(242,240,234,0.75)",
                  backgroundColor: PIVOTAL.has(stage) ? "#e58c63" : "rgba(242,240,234,0.07)",
                }}
              >
                {stage}
              </div>
              {i < STAGES.length - 1 ? <div style={{ display: "flex", width: 14, height: 1, backgroundColor: "rgba(242,240,234,0.3)" }} /> : null}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
