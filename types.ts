import * as z from "zod";

const envSchema = z.object({
  START_ROW_NO: z.coerce.number().int().min(1, "Invalid Start Row"),
  SHEET_COL_UPDATE: z.string().min(1, "SHEET_COL_UPDATE cannot be empty"),
  SPREADSHEET_ID: z.string().min(3, "Provide Sheet ID"),
});

export const env = envSchema.parse(Bun.env);
