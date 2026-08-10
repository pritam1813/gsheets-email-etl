import { sheets } from "./config";

interface UpdateEntry {
  row: number;
  value: string | null | undefined;
}

const dummy: UpdateEntry[] = [
  {
    row: 1,
    value: "manjunath@ascentcapital.in",
  },
  {
    row: 2,
    value: "sailesh@021.capital",
  },
  {
    row: 3,
    value: "saileshtulshan@gmail.com",
  },
  {
    row: 4,
    value: "Info@1000x.co.in",
  },
  {
    row: 5,
    value: "1008bharatgrowth@gmail.com",
  },
  {
    row: 6,
    value: "ankit@9unicorns.in",
  },
  {
    row: 7,
    value: "nk@108.vc",
  },
  {
    row: 8,
    value: "ronak@11hadvisors.com",
  },
  {
    row: 9,
    value: "info@paulasset.com",
  },
  {
    row: 10,
    value: "office@16alpha.in",
  },
  {
    row: 11,
    value: null,
  },
  {
    row: 12,
    value: null,
  },
];

async function updateSpreadsheet(data: UpdateEntry[]) {
  try {
    const col = Bun.env.SHEET_COL || "E";
    const sheetName = Bun.env.SHEET_NAME;

    const validEntries = data.filter((item) => {
      if (!item.value || item.value.trim() === "") return false;

      if (item.value === "unwanted_value") return false;

      return true;
    });

    if (validEntries.length === 0) {
      console.log("No valid values to update.");
      return;
    }
    const requests = validEntries.map((item) => ({
      range: `${sheetName}!${col}${item.row + 2}`,
      values: [[item.value]],
    }));

    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: Bun.env.SPREADSHEET_ID,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: requests,
      },
    });
    return response.data;
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

await updateSpreadsheet(dummy);
