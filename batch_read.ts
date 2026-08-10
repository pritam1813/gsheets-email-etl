import { sheets } from "./config";

export async function getSpreadsheetData() {
  try {
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: Bun.env.SPREADSHEET_ID,
      ranges: Bun.env.SHEET_RANGES?.split(","),
    });
    return response.data;
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

export const data = (await getSpreadsheetData()).valueRanges;

// Write data to temp file for testing
// await Bun.write("data.json", JSON.stringify(data, null, 2));
