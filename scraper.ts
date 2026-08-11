import { env } from "./env";
import type { MessageContent } from "./worker";

export interface WebsiteEnrichmentResult {
  website?: string;
  confidenceScore: number; // 0 to 100
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

/**
 * Extracts city from a typical Indian address string.
 * Pattern: "..., Area, City, CITY_CAPS, STATE, 560102"
 */
function extractCity(regAddress: string): string {
  const parts = regAddress
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Find the 6-digit pincode index and walk back to the city
  const pincodeIdx = parts.findIndex((p) => /^\d{6}$/.test(p));
  if (pincodeIdx >= 2) {
    // Layout: [..., city, CITY_CAPS, STATE, PINCODE]
    // So city is at pincodeIdx - 3, or pincodeIdx - 2 at minimum
    return parts[pincodeIdx - 3] ?? parts[pincodeIdx - 2] ?? parts[0] ?? "";
  }
  return parts[Math.max(0, parts.length - 3)] ?? "";
}

/**
 * Strips fund series suffixes and generic trust/fund words
 * so the search targets the AMC/manager entity rather than the specific tranche.
 * "021 CAPITAL TRUST - II" → "021 CAPITAL"
 */
function extractAMCKeyword(aifName: string): string {
  return aifName
    .replace(/\s*[-–]\s*(I{1,4}|IV|VI{0,3}|IX|X|\d{1,2})\s*$/i, "") // - II, - III, - 2, etc.
    .replace(/\b(TRUST|FUND|SCHEME|PLAN|SERIES|CLASS)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const EXCLUDED_SITES = [
  // Indian LEI registries
  "indialei.in",
  "globallei.in",
  "register-lei.in",
  "lei-worldwide.com",
  "gleif.org",
  "piedalies.lv",
  // Indian company/regulatory databases
  "sebi.gov.in",
  "mca.gov.in",
  "zaubacorp.com",
  "tofler.in",
  "occrp.org",
  // Financial aggregators
  "esi.in",
  "moneycontrol.com",
  "screener.in",
  "tickertape.in",
  "valueresearchonline.com",
  "mutualfundsindia.com",
  "morningstar.in",
  "groww.in",
  "etmoney.com",
  // News
  "bloomberg.com",
  "economictimes.indiatimes.com",
  "livemint.com",
  "businessstandard.com",
  "financialexpress.com",
  // Generic
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

  // Two signals:
  // 1. Exact full AIF name for direct hits
  // 2. Stripped AMC keyword + city to find the managing entity's site
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
    body: JSON.stringify({ q: query, num: 8 }), // fetch 8, LLM will filter
    redirect: "follow",
    signal: AbortSignal.timeout(15000), // 15 second timeout
  });

  if (!serperResponse.ok) {
    throw new Error(`Serper API error: ${serperResponse.statusText}`);
  }

  const serperResult: SerperResponse = await serperResponse.json();
  return serperResult.organic?.slice(0, 8) ?? [];
}

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
   - If a candidate is a listing/profile page (e.g. Crunchbase, LinkedIn, Caplight, Tracxn, LEI registry), look inside the snippet or title for the real website domain mentioned there (e.g. "021.capital", "35northventures.com"). Output that real domain, not the listing page URL.
   - If the candidate IS the official website itself (e.g. https://www.35northventures.com/), output that URL.
   - If a candidate's snippet explicitly states the company's website (e.g. "Visit us at xyz.com" or lists a domain), use that domain.
3. Filter out financial aggregators, news sites, directory pages, and third-party databases as the final "website" value — but you MAY read their snippets to extract the real domain.
4. Assign a confidenceScore (0 to 100):
   - 90-100: Direct match to official entity/AMC domain.
   - 70-89: Very likely match (e.g. parent company website extracted from a listing).
   - 40-69: Uncertain — no real domain could be extracted, only a third-party page found.
   - 0-39: No relevant or official site found.
5. Always output the website as a full URL with https:// prefix (e.g. "https://021.capital").

Output the result as a JSON object with the keys: "website" (string or null), "confidenceScore" (number), and "reasoning" (string).
`;

  const ollamaResponse = await fetch("http://127.0.0.1:11434/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3.5:4b",
      prompt: prompt,
      think: false,
      stream: false,
      format: {
        type: "object",
        properties: {
          website: { type: ["string", "null"] }, // ✅ allow null
          confidenceScore: { type: "number" },
          reasoning: { type: "string" },
        },
        required: ["website", "confidenceScore", "reasoning"], // ✅ require all fields
      },
      options: {
        temperature: 0.0,
      },
    }),
    signal: AbortSignal.timeout(60000), // 60 second timeout for LLM inference
  });

  if (!ollamaResponse.ok) {
    throw new Error(`Ollama API error: ${ollamaResponse.statusText}`);
  }

  const result = await ollamaResponse.json();
  try {
    const raw: string = result.response ?? "";

    if (!raw.trim()) {
      throw new Error("Empty response from Ollama.");
    }

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
    console.warn("Failed to parse Ollama JSON or received empty output. Raw output:", result.response);
    throw err; // Throw error to fail the task, instead of returning 0% confidence mock data
  }
}

/**
 * Known listing/aggregator hosts that should never be the final "website" output.
 * If the LLM still returns one of these despite prompt instructions, we reject it.
 */
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

/**
 * Post-processes the LLM output URL:
 * - Rejects known listing/aggregator hosts entirely.
 * - Normalizes to root domain (strips deep paths) for high-confidence official sites.
 */
function sanitizeWebsiteUrl(
  result: WebsiteEnrichmentResult,
): WebsiteEnrichmentResult {
  if (!result.website) return result;

  let url: URL;
  try {
    url = new URL(result.website);
  } catch {
    // Not a valid URL — clear it
    return { ...result, website: undefined, confidenceScore: 0 };
  }

  const hostname = url.hostname.replace(/^www\./, "");

  // Reject if it's a known listing/aggregator site
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

  // For high-confidence hits, strip to root domain only (no deep paths)
  if (result.confidenceScore >= 70) {
    const root = `${url.protocol}//${url.hostname}`;
    return { ...result, website: root };
  }

  return result;
}

export async function enrichWebsiteFromWeb(
  data: MessageContent,
): Promise<WebsiteEnrichmentResult | undefined> {
  try {
    console.log(`[Row ${data.row}] Calling Serper API...`);
    const organicResults = await performSerperSearch(data);
    
    console.log(`[Row ${data.row}] Calling Ollama API...`);
    const raw = await evaluateCandidatesWithLLM(data, organicResults);
    
    console.log(`[Row ${data.row}] Finished processing LLM response.`);
    return sanitizeWebsiteUrl(raw);
  } catch (error) {
    console.error(`Error in enrichWebsiteFromWeb (Row ${data.row}):`, error);
    throw error; // Rethrow so worker.ts can catch it and nack the message!
  }
}
