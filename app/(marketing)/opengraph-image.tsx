import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * A real, honest brand card - company name + tagline in the site's own
 * palette - not a fabricated product screenshot or invented metric.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          backgroundColor: "#020617",
          color: "#ffffff",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              display: "flex",
              width: 44,
              height: 44,
              borderRadius: 10,
              backgroundColor: "#ffffff",
              color: "#020617",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              fontWeight: 700,
            }}
          >
            C
          </div>
          <div style={{ fontSize: 26, fontWeight: 600, color: "#e2e8f0" }}>Contractor Growth Co.</div>
        </div>

        <div style={{ display: "flex", marginTop: 56, fontSize: 60, fontWeight: 600, letterSpacing: -1.5, maxWidth: 900 }}>
          Turn More Leads Into Booked Jobs.
        </div>

        <div style={{ display: "flex", marginTop: 28, fontSize: 26, color: "#94a3b8", maxWidth: 820 }}>
          Your website, AI, follow-up, and business analytics — all working together.
        </div>

        <div style={{ display: "flex", marginTop: 56, width: 90, height: 6, borderRadius: 999, backgroundColor: "#10b981" }} />
      </div>
    ),
    { ...size },
  );
}
