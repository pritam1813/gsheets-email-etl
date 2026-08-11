import type { sheets_v4 } from "@googleapis/sheets";
import * as z from "zod";
import { sheets } from "./config";
import { genericEmails } from "./generic_emails";
import { env } from "./env";
import { publisher } from "./redis";

// --- Schemas ---

const BatchSheetsDataSchema = z.object({
  range: z.string(),
  majorDimension: z.string(),
  values: z.array(z.array(z.string())).optional(),
});

const ResSchema = z.array(BatchSheetsDataSchema);

// --- Helpers ---
await publisher.connect();

async function publishLogMessage(
  index: number,
  aifNames: string[][],
  regAddresses: string[][],
  correspondanceAddresses: string[][],
) {
  const message = {
    row: index + env.START_ROW_NO,
    aifName: aifNames[index]?.[0],
    regAddress: regAddresses[index]?.[0],
    correspondanceAddress: correspondanceAddresses[index]?.[0],
  };

  await publisher.publish(env.REDIS_CHANNEL, JSON.stringify(message));
}

// --- Main ---

const rawData = await Bun.file("data.json").json();
const res = ResSchema.parse(rawData); // throws ZodError on bad shape

const aifNames = res[0]?.values ?? [];
const emailValues = res[1]?.values ?? [];
const regAddresses = res[2]?.values ?? [];
const correspondanceAddresses = res[3]?.values ?? [];

const domainValues: string[][] = await Promise.all(
  emailValues.map(async (item, index) => {
    const email = item[0];
    const domain = email?.split("@")[1]?.toLowerCase();

    if (!email || !domain || genericEmails.has(domain)) {
      await publishLogMessage(
        index,
        aifNames,
        regAddresses,
        correspondanceAddresses,
      );
      return [""];
    }

    return [`https://${domain}`];
  }),
);

publisher.close();

const requests: sheets_v4.Schema$ValueRange[] = [
  { range: env.SHEET_COL_UPDATE, values: domainValues },
];

// console.log(requests);

// if (env.SPREADSHEET_ID) {
//   await sheets.spreadsheets.values.batchUpdate({
//     spreadsheetId: env.SPREADSHEET_ID,
//     requestBody: { valueInputOption: "USER_ENTERED", data: requests },
//   });
// }
