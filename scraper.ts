import { env } from "./env";
import type { MessageContent } from "./worker";

export interface WebsiteEnrichmentResult {
  website?: string;
  confidenceScore: number;
  reasoning?: string;
}

export interface SerperOrganicResult {
  title: string;
  link: string;
  snippet: string;
  position: number;
}

interface SerperResponse {
  organic?: SerperOrganicResult[];
}

// ─── Gemini Rate Limiter ────────────────────────────────────────────────────
// Tune these to match the model you pick from AI Studio dashboard.
//
// Model               RPM   RPD
// gemini-2.5-flash     5     20   ← you're already over this
// gemini-2.5-flash-lite 10   20
// gemini-3.5-flash-lite 15  500   ← recommended
// gemini-3.1-flash-lite 15  500

const GEMINI_MODEL = "gemini-3.5-flash-lite"; // change to preferred model
const GEMINI_RPM_LIMIT = 15; // match the model's RPM above
const GEMINI_RPD_LIMIT = 500; // match the model's RPD above

class GeminiRateLimiter {
  private minuteWindow: number[] = []; // timestamps of recent requests
  private dailyCount = 0;
  private dayStartMs = Date.now();

  async throttle(): Promise<void> {
    const now = Date.now();

    // Reset daily counter when 24h window has elapsed
    if (now - this.dayStartMs >= 24 * 60 * 60 * 1000) {
      this.dailyCount = 0;
      this.dayStartMs = now;
    }

    if (this.dailyCount >= GEMINI_RPD_LIMIT) {
      throw new Error(
        `Gemini RPD limit (${GEMINI_RPD_LIMIT}/day) reached. Retry after midnight UTC.`,
      );
    }

    // Sliding 60-second window for RPM
    const windowCutoff = now - 60_000;
    this.minuteWindow = this.minuteWindow.filter((t) => t > windowCutoff);

    if (this.minuteWindow.length >= GEMINI_RPM_LIMIT) {
      // Wait until the oldest request in the window expires
      const oldestTs = this.minuteWindow[0]!;
      const waitMs = oldestTs + 60_000 - now + 200; // 200ms safety buffer
      console.log(`[Gemini] RPM limit reached. Waiting ${waitMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.minuteWindow.push(Date.now());
    this.dailyCount++;
  }

  get stats() {
    return {
      rpm: `${this.minuteWindow.length}/${GEMINI_RPM_LIMIT}`,
      rpd: `${this.dailyCount}/${GEMINI_RPD_LIMIT}`,
    };
  }
}

// Singleton — shared across all calls in this process
const geminiRateLimiter = new GeminiRateLimiter();

// ─── Serper search (unchanged) ──────────────────────────────────────────────

function extractCity(regAddress: string): string {
  const parts = regAddress
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const pincodeIdx = parts.findIndex((p) => /^\d{6}$/.test(p));
  if (pincodeIdx >= 2) {
    return parts[pincodeIdx - 3] ?? parts[pincodeIdx - 2] ?? parts[0] ?? "";
  }
  return parts[Math.max(0, parts.length - 3)] ?? "";
}

function extractAMCKeyword(aifName: string): string {
  return aifName
    .replace(/\s*[-–]\s*(I{1,4}|IV|VI{0,3}|IX|X|\d{1,2})\s*$/i, "")
    .replace(/\b(TRUST|FUND|SCHEME|PLAN|SERIES|CLASS)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const EXCLUDED_SITES = [
  "indialei.in",
  "globallei.in",
  "register-lei.in",
  "lei-worldwide.com",
  "gleif.org",
  "piedalies.lv",
  "sebi.gov.in",
  "mca.gov.in",
  "zaubacorp.com",
  "tofler.in",
  "occrp.org",
  "esi.in",
  "moneycontrol.com",
  "screener.in",
  "tickertape.in",
  "valueresearchonline.com",
  "mutualfundsindia.com",
  "morningstar.in",
  "groww.in",
  "etmoney.com",
  "bloomberg.com",
  "economictimes.indiatimes.com",
  "livemint.com",
  "businessstandard.com",
  "financialexpress.com",
  "linkedin.com",
  "crunchbase.com",
  "tracxn.com",
  "wikipedia.org",
  "justdial.com",
  "indiamart.com",
]
  .map((site) => `-site:${site}`)
  .join(" ");

async function performSerperSearch(
  data: MessageContent,
): Promise<SerperOrganicResult[]> {
  const city = extractCity(String(data.regAddress ?? ""));
  const amcKeyword = extractAMCKeyword(data.aifName);

  const query = [
    `"${data.aifName}" OR "${amcKeyword}"`,
    city ? `"${city}"` : "",
    `(site:*.in OR site:*.com)`,
    `(investment OR "asset management" OR "fund manager" OR "AMC")`,
    EXCLUDED_SITES,
    `-filetype:pdf`,
  ]
    .filter(Boolean)
    .join(" ");

  const serperHeaders = new Headers();
  serperHeaders.append("X-API-KEY", env.SERPER_API_KEY);
  serperHeaders.append("Content-Type", "application/json");

  const serperResponse = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: serperHeaders,
    body: JSON.stringify({ q: query, num: 8 }),
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!serperResponse.ok) {
    throw new Error(`Serper API error: ${serperResponse.statusText}`);
  }

  const serperResult: SerperResponse = await serperResponse.json();
  return serperResult.organic?.slice(0, 8) ?? [];
}

// ─── LLM: Gemini ────────────────────────────────────────────────────────────

async function evaluateCandidatesWithLLM(
  data: MessageContent,
  organicResults: SerperOrganicResult[],
): Promise<WebsiteEnrichmentResult> {
  if (organicResults.length === 0) {
    return {
      website: undefined,
      confidenceScore: 0,
      reasoning: "No organic search results found.",
    };
  }

  const candidatesText = organicResults
    .map(
      (item, index) =>
        `[Candidate ${index + 1}]
Title: ${item.title}
URL: ${item.link}
Snippet: ${item.snippet}`,
    )
    .join("\n\n");

  const prompt = `
You evaluate search candidates to find the OFFICIAL website or parent AMC domain for this Alternative Investment Fund (AIF).

AIF Name: "${data.aifName}"
Registered Address Context: "${data.regAddress ?? ""}"

Search Candidates:
${candidatesText}

Instructions:
1. Determine if any of the candidates lead to the official website of the AIF or its Managing AMC.
2. CRITICAL: The "website" you output must be the ACTUAL official domain of the business, NOT the URL of the search result itself.
   - If a candidate is a listing/profile page (e.g. Crunchbase, LinkedIn, Caplight, Tracxn, LEI registry), look inside the snippet or title for the real website domain mentioned there (e.g. "021.capital"). Output that real domain, not the listing page URL.
   - If the candidate IS the official website itself, output that URL directly.
   - If a candidate's snippet explicitly states the company's website, use that domain.
3. Filter out financial aggregators, news sites, directory pages, and third-party databases as the final "website" value — but you MAY read their snippets to extract the real domain.
4. Assign a confidenceScore (0 to 100):
   - 90-100: Direct match to official entity/AMC domain.
   - 70-89: Very likely match (e.g. parent company website extracted from a listing).
   - 40-69: Uncertain — no real domain could be extracted, only a third-party page found.
   - 0-39: No relevant or official site found.
5. Always output the website as a full URL with https:// prefix. Set to null if nothing credible found.
`.trim();

  // Respect Gemini rate limits before firing the request
  await geminiRateLimiter.throttle();
  console.log(
    `[Row ${data.row}] Gemini usage → ${JSON.stringify(geminiRateLimiter.stats)}`,
  );

  const geminiResponse = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              website: { type: "STRING", nullable: true },
              confidenceScore: { type: "NUMBER" },
              reasoning: { type: "STRING" },
            },
            required: ["website", "confidenceScore", "reasoning"],
          },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!geminiResponse.ok) {
    const errBody = await geminiResponse.text();
    throw new Error(`Gemini API error ${geminiResponse.status}: ${errBody}`);
  }

  const geminiJson = await geminiResponse.json();

  // Gemini response shape: candidates[0].content.parts[0].text
  const raw: string =
    geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  if (!raw.trim()) {
    throw new Error("Empty response from Gemini.");
  }

  try {
    const parsed = JSON.parse(raw) as {
      website: string | null;
      confidenceScore: number;
      reasoning: string;
    };

    return {
      website: parsed.website ?? undefined,
      confidenceScore: parsed.confidenceScore,
      reasoning: parsed.reasoning,
    };
  } catch (err) {
    console.warn("Failed to parse Gemini JSON. Raw output:", raw);
    throw err;
  }
}

// ─── Post-processing (unchanged) ────────────────────────────────────────────

const LISTING_SITE_HOSTS = new Set([
  "caplight.com",
  "crunchbase.com",
  "tracxn.com",
  "linkedin.com",
  "scribd.com",
  "filesure.in",
  "tofler.in",
  "zaubacorp.com",
  "lei-lookup.com",
  "indialei.in",
  "gleif.org",
  "bloomberg.com",
  "moneycontrol.com",
  "groww.in",
  "occrp.org",
  "justdial.com",
  "indiamart.com",
]);

function sanitizeWebsiteUrl(
  result: WebsiteEnrichmentResult,
): WebsiteEnrichmentResult {
  if (!result.website) return result;

  let url: URL;
  try {
    url = new URL(result.website);
  } catch {
    return { ...result, website: undefined, confidenceScore: 0 };
  }

  const hostname = url.hostname.replace(/^www\./, "");

  if (LISTING_SITE_HOSTS.has(hostname)) {
    return {
      ...result,
      website: undefined,
      confidenceScore: Math.min(result.confidenceScore, 30),
      reasoning:
        result.reasoning +
        " [sanitized: listing-site URL rejected; no real business domain extracted]",
    };
  }

  if (result.confidenceScore >= 70) {
    return { ...result, website: `${url.protocol}//${url.hostname}` };
  }

  return result;
}

// ─── Public entry point ──────────────────────────────────────────────────────

export async function enrichWebsiteFromWeb(
  data: MessageContent,
): Promise<WebsiteEnrichmentResult | undefined> {
  try {
    console.log(`[Row ${data.row}] Calling Serper API...`);
    const organicResults = await performSerperSearch(data);

    console.log(`[Row ${data.row}] Calling Gemini API...`);
    const raw = await evaluateCandidatesWithLLM(data, organicResults);

    console.log(`[Row ${data.row}] Done.`);
    return sanitizeWebsiteUrl(raw);
  } catch (error) {
    console.error(`Error in enrichWebsiteFromWeb (Row ${data.row}):`, error);
    throw error;
  }
}
