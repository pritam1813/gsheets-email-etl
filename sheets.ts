import { sheets } from "./config";
import { env } from "./env";
import type { WebsiteEnrichmentResult } from "./scraper";

/**
 * Converts a 1-based sheet row number to an A1-notation range
 * spanning the three output columns: website, confidence score, reasoning.
 *
 * Example: row=5, baseCol="E"  →  "Sheet1!E5:G5"
 */
function rowToRange(row: number): string {
  // Derive sheet name from SHEET_COL_UPDATE (e.g. "Sheet1!E3:E29" → "Sheet1")
  const sheetName = env.SHEET_COL_UPDATE.split("!")[0] ?? "Sheet1";

  // Derive the start column letter from SHEET_COL_UPDATE (e.g. "Sheet1!E3:E29" → "E")
  const startCol =
    env.SHEET_COL_UPDATE.split("!")[1]?.replace(/[^A-Za-z]/g, "")[0] ?? "E";

  // Build end column: next two letters after startCol
  const startCode = startCol.toUpperCase().charCodeAt(0);
  const endCol = String.fromCharCode(startCode + 2); // e.g. E → G

  return `${sheetName}!${startCol}${row}:${endCol}${row}`;
}

/**
 * Writes the enrichment result for a single row back to the Google Sheet.
 * Updates three columns in order:
 *   - Col +0 (e.g. E): website URL
 *   - Col +1 (e.g. F): confidence score
 *   - Col +2 (e.g. G): reasoning
 */
export async function updateSingleSheetRow(
  row: number,
  result: WebsiteEnrichmentResult | undefined,
): Promise<void> {
  const range = rowToRange(row);

  const values = [
    [
      result?.website ?? "",
      `${result?.confidenceScore ?? 0}%`,
      result?.reasoning ?? "",
    ],
  ];

  await sheets.spreadsheets.values.update({
    spreadsheetId: env.SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}
