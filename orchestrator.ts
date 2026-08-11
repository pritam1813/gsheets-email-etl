import type { sheets_v4 } from "@googleapis/sheets";
import * as z from "zod";
import { sheets } from "./config";
import { genericEmails } from "./generic_emails";
import { env } from "./env";
import { getRabbitChannel } from "./rabbitmq";
import { data } from "./batch_read";

// --- Schemas ---

const BatchSheetsDataSchema = z.object({
  range: z.string(),
  majorDimension: z.string(),
  values: z.array(z.array(z.string())).optional(),
});

const ResSchema = z.array(BatchSheetsDataSchema);

// --- Main ---

// const rawData = await Bun.file("data.json").json();
const res = ResSchema.parse(data); // throws ZodError on bad shape

const { connection, channel } = await getRabbitChannel();

const COLS = {
  AIF_NAME: 0,
  EMAIL: 7,
  REG_ADDRESS: 13,
  COR_ADDRESS: 17,
  WEBSITE: 3,
} as const;

const rows = res[0]?.values ?? [];

const sheetName = env.SHEET_COL_UPDATE.split("!")[0] ?? "Sheet1";
const websiteCol = env.SHEET_COL_UPDATE.split("!")[1]?.replace(/[^A-Za-z]/g, "")[0] ?? "E";

const requests: sheets_v4.Schema$ValueRange[] = [];

for (let index = 0; index < rows.length; index++) {
  const row = rows[index];
  if (!row) continue;

  const email = row[COLS.EMAIL];
  const existingWebsite = row[COLS.WEBSITE];
  const aifName = row[COLS.AIF_NAME];
  const regAddress = row[COLS.REG_ADDRESS];
  const correspondanceAddress = row[COLS.COR_ADDRESS];

  if (existingWebsite) {
    // Already has a website, don't overwrite it
    continue;
  }

  const domain = email?.split("@")[1]?.toLowerCase();
  const rowNum = index + env.START_ROW_NO;

  if (!email || !domain || genericEmails.has(domain)) {
    const payload = {
      row: rowNum,
      aifName,
      regAddress,
      correspondanceAddress,
    };

    channel.sendToQueue(env.QUEUE_NAME, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
    });
    // We NO LONGER push an empty string here to avoid overwriting!
  } else {
    // Update ONLY this specific cell
    requests.push({
      range: `${sheetName}!${websiteCol}${rowNum}`,
      values: [[`https://${domain}`]],
    });
  }
}

await channel.close();
await connection.close();

if (env.SPREADSHEET_ID && requests.length > 0) {
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.SPREADSHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data: requests },
  });
}
