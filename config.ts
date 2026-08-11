import { google } from "googleapis";
import { sheets_v4 } from "@googleapis/sheets";
import { env } from "./env";

const oauth2client = new google.auth.OAuth2({
  client_id: env.OAUTH_CLIENT_ID,
  client_secret: env.OAUTH_CLIENT_SECRET,
});

oauth2client.setCredentials({
  refresh_token: env.OAUTH_REFRESH_TOKEN,
});

export const sheets = new sheets_v4.Sheets({
  auth: oauth2client,
});

