import * as z from "zod";

const envSchema = z.object({
  START_ROW_NO: z.coerce.number().int().min(1, "Invalid Start Row"),
  SHEET_COL_UPDATE: z.string().min(1, "SHEET_COL_UPDATE cannot be empty"),
  SPREADSHEET_ID: z.string().min(3, "Provide Sheet ID"),
  OAUTH_CLIENT_ID: z.string().min(1, "OAUTH_CLIENT_ID is required"),
  OAUTH_CLIENT_SECRET: z.string().min(1, "OAUTH_CLIENT_SECRET is required"),
  OAUTH_REFRESH_TOKEN: z.string().min(1, "OAUTH_REFRESH_TOKEN is required"),
  RABBITMQ_URL: z.url("Invalid RabbitMQ URL"),
  QUEUE_NAME: z.string().min(1).default("gsheet-etl"),
});

export const env = envSchema.parse(Bun.env);
