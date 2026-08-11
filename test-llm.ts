import { enrichWebsiteFromWeb } from "./scraper";

const TEST_CASES = [
  {
    label: "All LEI registries — expect null + low confidence",
    data: {
      row: 1,
      aifName: "021 CAPITAL TRUST - II",
      regAddress:
        "No. 26, Ozone Residenza,, 3/3 Harlur Main Road,HSR Layout, Bangalore, BANGALORE, KARNATAKA, 560102",
      correspondanceAddress:
        "No. 26, Ozone Residenza, 3/3 Harlur Main Road,HSR Layout, Bangalore, BANGALORE, KARNATAKA, 560102",
    },
  },
  {
    label: "Well-known AMC — expect high confidence official site",
    data: {
      row: 2,
      aifName: "MIRAE ASSET INDIA OPPORTUNITIES FUND - I",
      regAddress:
        "Unit No. 606, 6th Floor, Windsor Building, Off CST Road, Kalina, Santacruz (East), Mumbai, MUMBAI, MAHARASHTRA, 400098",
      correspondanceAddress:
        "Unit No. 606, 6th Floor, Windsor Building, Off CST Road, Kalina, Santacruz (East), Mumbai, MUMBAI, MAHARASHTRA, 400098",
    },
  },
  {
    label: "Smaller/obscure fund — expect low confidence or null",
    data: {
      row: 3,
      aifName: "AAVISHKAAR BHARAT FUND",
      regAddress:
        "801, Inspire BKC, Bandra Kurla Complex, Bandra East, Mumbai, MUMBAI, MAHARASHTRA, 400051",
      correspondanceAddress:
        "801, Inspire BKC, Bandra Kurla Complex, Bandra East, Mumbai, MUMBAI, MAHARASHTRA, 400051",
    },
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function confidenceBand(score: number): string {
  if (score >= 90) return "🟢 HIGH";
  if (score >= 70) return "🟡 LIKELY";
  if (score >= 40) return "🟠 UNCERTAIN";
  return "🔴 LOW";
}

function printResult(
  label: string,
  result: Awaited<ReturnType<typeof enrichWebsiteFromWeb>>,
  durationMs: number,
) {
  console.log("\n" + "─".repeat(60));
  console.log(`📋 ${label}`);
  console.log("─".repeat(60));
  if (!result) {
    console.log("  ⚠️  No result returned (undefined)");
    return;
  }
  console.log(`  Website    : ${result.website ?? "(null)"}`);
  console.log(
    `  Confidence : ${result.confidenceScore} — ${confidenceBand(result.confidenceScore)}`,
  );
  console.log(`  Reasoning  : ${result.reasoning}`);
  console.log(`  Duration   : ${durationMs}ms`);
}

// ─── Runner ─────────────────────────────────────────────────────────────────

async function runTests() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  LLM Enrichment Test  —  ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}`);

  const summary: Array<{
    label: string;
    website: string | undefined;
    score: number;
    ok: boolean;
  }> = [];

  for (const tc of TEST_CASES) {
    console.log(`\n⏳ Running: "${tc.label}"...`);
    const start = Date.now();

    try {
      const result = await enrichWebsiteFromWeb(tc.data);
      const duration = Date.now() - start;
      printResult(tc.label, result, duration);
      summary.push({
        label: tc.label,
        website: result?.website,
        score: result?.confidenceScore ?? 0,
        ok: true,
      });
    } catch (err) {
      const duration = Date.now() - start;
      console.log("\n" + "─".repeat(60));
      console.log(`📋 ${tc.label}`);
      console.log("─".repeat(60));
      console.log(`  ❌ FAILED after ${duration}ms`);
      console.log(
        `  Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      summary.push({
        label: tc.label,
        website: undefined,
        score: 0,
        ok: false,
      });
    }
  }

  // ─── Summary table ─────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log("  SUMMARY");
  console.log("═".repeat(60));
  for (const s of summary) {
    const status = s.ok ? (s.score >= 70 ? "✅" : "⚠️ ") : "❌";
    console.log(`  ${status} [${String(s.score).padStart(3)}] ${s.label}`);
    if (s.website) console.log(`       → ${s.website}`);
  }
  console.log("═".repeat(60) + "\n");
}

runTests().catch(console.error);
