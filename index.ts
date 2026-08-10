import { sheets } from "./config";

async function getSpreadsheetData() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: Bun.env.SPREADSHEET_ID,
    range: `${Bun.env.SHEET_NAME}!${Bun.env.SHEET_COL}:${Bun.env.SHEET_COL}`,
  });
  return response.data;
}

const data = await getSpreadsheetData();

console.log(data.values);
