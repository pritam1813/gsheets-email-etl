import { GoogleGenAI, Type } from "@google/genai";
import { sheets } from "./config";
import { env } from "./env";
import { updateSingleSheetRow } from "./sheets";
import * as fs from "fs";

function logToFile(message: string) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync("rerun_log.txt", `[${timestamp}] ${message}\n`);
}

const ai = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY,
});

const GEMINI_RPM_LIMIT = 8;
const GEMINI_RPD_LIMIT = 500;

class GeminiRateLimiter {
  private minuteWindow: number[] = [];
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
        `Gemini RPD limit (${GEMINI_RPD_LIMIT}/day) reached. Retry after 24 hours.`,
      );
    }

    // Sliding 60-second window for RPM
    const windowCutoff = now - 60_000;
    this.minuteWindow = this.minuteWindow.filter((t) => t > windowCutoff);

    if (this.minuteWindow.length >= GEMINI_RPM_LIMIT) {
      const oldestTs = this.minuteWindow[0]!;
      const waitMs = oldestTs + 60_000 - now + 200; // 200ms safety buffer
      console.log(`[RateLimit] RPM limit reached. Waiting ${waitMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.minuteWindow.push(Date.now());
    this.dailyCount++;
  }
}

const rateLimiter = new GeminiRateLimiter();

// Indices based on the sheet where B is 0
const COLS = {
  AIF_NAME: 0,
  REG_NO: 1,
  WEBSITE: 3, // Column E
  CONF_SCORE: 4, // Column F
  REASONING: 5, // Column G
  CONTACT_PERSON: 6, // Column H
  EMAIL: 7, // Column I
  REG_ADDRESS: 13,
  COR_ADDRESS: 17,
} as const;

function extractStartRow(range: string): number {
  const match = range.match(/![A-Za-z]+(\d+)/);
  if (match && match[1]) return parseInt(match[1], 10);
  const match2 = range.match(/^[A-Za-z]+(\d+)/);
  if (match2 && match2[1]) return parseInt(match2[1], 10);
  throw new Error("Could not extract start row from range: " + range);
}

async function processRow(rowNum: number, entityDetails: any) {
  const { name, regNo, regAddress, corAddress, contactPerson, email } = entityDetails;

  const prompt = `
Task: Find the official website associated with the following registered entity. 

Entity Details:
- Name: ${name}
- Registration: ${regNo || "N/A"}
- Contact Person: ${contactPerson || "N/A"}
- Email: ${email || "N/A"}
- Address: ${regAddress || "N/A"}
- Correspondence Address: ${corAddress || "N/A"}

Investigation Rules:
1. First, search for the exact entity name. Look for a website domain that closely matches the entity's name (e.g., 'ARIGATO CAPITAL FUND' -> 'arigatocapital.in'). Prioritize a direct domain match OVER any parent company.
2. To verify a direct domain match, check if the website mentions the provided Contact Person, Email, Address, or Registration Number.
3. If a direct domain match is found but none of those exact details are explicitly visible in the search snippet, you may still accept it if the business description strongly aligns with the entity.
4. ONLY if you cannot find a direct website for the entity, then search for its parent venture capital firm, management company, or look for listed business emails on MCA/SEBI directories.
5. When relying on a parent company website as a fallback, you MUST cross-reference the Address, Contact Person, or Email to verify it.
6. Do NOT return directory pages, financial aggregators, news sites, or third-party databases (like crunchbase, zaubacorp, etc) as the website. 

CRITICAL SCORING RULE (0-100): Adjust the confidenceScore based on the strength of the match:
- 95-100: Direct domain name match AND explicit verification found (Contact Person, Email, Address, or RegNo explicitly mentioned on the site).
- 80-94: Direct domain name match, but explicit details (like address/person) are not visible in the snippet; however, the business clearly aligns.
- 60-79: No direct domain found, but a parent company or management firm website was found AND strongly verified via exact Address or Contact Person match.
- 0: No valid official website found, or only a directory/aggregator was found. (If website is empty, score MUST be 0).


CRITICAL INSTRUCTION: Output your response strictly as a JSON object, with no markdown formatting or extra text. Use the following schema:
{
  "website": "The verified official website URL starting with https://. If not found, return an empty string.",
  "confidenceScore": 0-100 integer (Must be 0 if website is empty),
  "reasoning": "Reasoning for the extracted website, detailing the email domain or address match that verified it."
}
`;

  await rateLimiter.throttle();

  console.log(
    `[Row ${rowNum}] Generating content via Gemini with googleSearch...`,
  );
  const response = await ai.models.generateContent({
    model: "gemma-4-31b-it", // Updated model for search grounding
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      temperature: 0,
    },
  });

  // Strip markdown JSON block if present
  let rawText = response.text || "";
  rawText = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  let result;
  try {
    result = JSON.parse(rawText);
  } catch (err) {
    console.error(`[Row ${rowNum}] Failed to parse JSON:`, rawText);
    throw err;
  }

  const { website, confidenceScore, reasoning } = result;

  const finalResult = {
    website: website?.trim() ? website.trim() : undefined,
    confidenceScore: typeof confidenceScore === "number" ? confidenceScore : 0,
    reasoning: reasoning || "",
  };

  console.log(
    `[Row ${rowNum}] Result -> Website: ${finalResult.website}, Score: ${finalResult.confidenceScore}`,
  );

  await updateSingleSheetRow(rowNum, finalResult);
  console.log(`[Row ${rowNum}] Successfully updated Google Sheet.`);
}

async function main() {
  const rerunRange = process.argv[2];

  if (!rerunRange) {
    console.error("Usage: bun rerun.ts <SHEET_RANGE>");
    console.error("Example: bun rerun.ts Sheet1!B3:S1938");
    process.exit(1);
  }

  console.log(`Fetching data for range: ${rerunRange}...`);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: env.SPREADSHEET_ID,
    range: rerunRange,
  });

  const rows = response.data.values || [];
  if (rows.length === 0) {
    console.log("No data found in the specified range.");
    return;
  }

  const startRow = extractStartRow(rerunRange);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = startRow + i;

    if (!row) continue;

    const confScoreStr = row[COLS.CONF_SCORE] || "";
    const confScore = parseInt(confScoreStr.replace("%", ""), 10) || 0;

    // Condition: confidence < 75 and cell is not empty
    if (confScoreStr.trim() !== "" && confScore < 75) {
      console.log(`\n--- Processing Row ${rowNum} ---`);

      const entityDetails = {
        name: row[COLS.AIF_NAME] || "",
        regNo: row[COLS.REG_NO] || "",
        regAddress: row[COLS.REG_ADDRESS] || "",
        corAddress: row[COLS.COR_ADDRESS] || "",
        contactPerson: row[COLS.CONTACT_PERSON] || "",
        email: row[COLS.EMAIL] || "",
      };

      let success = false;
      let attempts = 0;
      const MAX_RETRIES = 5;

      while (!success && attempts < MAX_RETRIES) {
        attempts++;
        try {
          await processRow(rowNum, entityDetails);
          success = true;
          logToFile(`[Row ${rowNum}] Successfully processed on attempt ${attempts}.`);
        } catch (err: any) {
          const isRetryable = err?.status === 503 || err?.message?.includes("503") || err?.status === 429 || err?.message?.includes("429");
          
          if (isRetryable && attempts < MAX_RETRIES) {
            const waitTime = attempts * 15000; // 15s, 30s, 45s...
            console.warn(`[Row ${rowNum}] Got retryable error (503/429). Retrying in ${waitTime/1000}s (Attempt ${attempts} of ${MAX_RETRIES})...`);
            logToFile(`[Row ${rowNum}] Got retryable error. Retrying (Attempt ${attempts})...`);
            await new Promise(res => setTimeout(res, waitTime));
          } else {
            console.error(`[Row ${rowNum}] Error processing row after ${attempts} attempts:`, err);
            logToFile(`[Row ${rowNum}] FAILED after ${attempts} attempts. Error: ${err?.message || String(err)}`);
            break;
          }
        }
      }
    }
  }

  console.log("\nPipeline finished.");
}

main().catch(console.error);
