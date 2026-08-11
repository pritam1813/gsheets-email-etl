import type { sheets_v4 } from "@googleapis/sheets";
import * as z from "zod";
import { sheets } from "./config";
import { genericEmails } from "./generic_emails";
import { env } from "./env";
import { getRabbitChannel } from "./rabbitmq";

// --- Schemas ---

const BatchSheetsDataSchema = z.object({
  range: z.string(),
  majorDimension: z.string(),
  values: z.array(z.array(z.string())).optional(),
});

const ResSchema = z.array(BatchSheetsDataSchema);

// --- Main ---

const rawData = await Bun.file("data.json").json();
const res = ResSchema.parse(rawData); // throws ZodError on bad shape

const { connection, channel } = await getRabbitChannel();

const COLS = {
  AIF_NAME: 0,
  EMAIL: 7,
  REG_ADDRESS: 13,
  COR_ADDRESS: 17,
  WEBSITE: 3,
} as const;

const rows = res[0]?.values ?? [];

const domainValues: string[][] = [];

for (let index = 0; index < rows.length; index++) {
  const row = rows[index];
  if (!row) continue;

  const email = row[COLS.EMAIL];
  const existingWebsite = row[COLS.WEBSITE];
  const aifName = row[COLS.AIF_NAME];
  const regAddress = row[COLS.REG_ADDRESS];
  const correspondanceAddress = row[COLS.COR_ADDRESS];

  if (existingWebsite) {
    domainValues.push([existingWebsite]);
    continue;
  }

  const domain = email?.split("@")[1]?.toLowerCase();

  if (!email || !domain || genericEmails.has(domain)) {
    const payload = {
      row: index + env.START_ROW_NO,
      aifName,
      regAddress,
      correspondanceAddress,
    };

    channel.sendToQueue(env.QUEUE_NAME, Buffer.from(JSON.stringify(payload)), {
      persistent: true,
    });

    domainValues.push([""]);
  } else {
    domainValues.push([`https://${domain}`]);
  }
}

await channel.close();
await connection.close();

const requests: sheets_v4.Schema$ValueRange[] = [
  { range: env.SHEET_COL_UPDATE, values: domainValues },
];

console.log(requests);

// if (env.SPREADSHEET_ID) {
//   await sheets.spreadsheets.values.batchUpdate({
//     spreadsheetId: env.SPREADSHEET_ID,
//     requestBody: { valueInputOption: "USER_ENTERED", data: requests },
//   });
// }
