import { sheets } from "./config";

export async function getSpreadsheetData() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: Bun.env.SPREADSHEET_ID,
      range: `${Bun.env.SHEET_NAME}!${Bun.env.SHEET_START}:${Bun.env.SHEET_END}`,
    });
    return response.data;
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

const data = await getSpreadsheetData();

export const rowsWithNumbers =
  data.values?.map((row, index) => ({
    row: index + 1,
    value: row[0] ?? null,
  })) ?? [];
