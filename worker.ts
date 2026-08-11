// worker.ts
import { getRabbitChannel } from "./rabbitmq";
import { env } from "./env";
import { enrichWebsiteFromWeb } from "./scraper";
import { updateSingleSheetRow, isRowAlreadyProcessed } from "./sheets";

/** Writes directly to stdout so logs flush immediately (bypasses Bun buffering). */
const log = (...args: unknown[]) =>
  process.stdout.write(
    args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
      .join(" ") + "\n",
  );

export interface MessageContent {
  row: number;
  aifName: string;
  regAddress?: string;
  correspondanceAddress?: string;
}

async function startWorker() {
  const { channel } = await getRabbitChannel();

  // Tell RabbitMQ to only give this worker 1 unacknowledged message at a time.
  // This prevents one worker from hogging all tasks if you run multiple workers.
  await channel.prefetch(1);

  console.log(
    `[*] Waiting for messages in ${env.QUEUE_NAME}. To exit press CTRL+C`,
  );

  channel.consume(env.QUEUE_NAME, async (msg) => {
    if (msg !== null) {
      try {
        const data: MessageContent = JSON.parse(msg.content.toString());
        log(`[x] Received task for Row: ${data.row}`);

        // 0. Check if already updated in the sheet
        const isProcessed = await isRowAlreadyProcessed(data.row);
        if (isProcessed) {
          log(`[~] Row ${data.row} already has data in the sheet. Skipping.`);
          channel.ack(msg);
          return;
        }

        // 1. Do the heavy lifting (Web search, API calls, etc.)
        const result = await enrichWebsiteFromWeb(data);

        // 2. Update Google Sheet for this specific row
        await updateSingleSheetRow(data.row, result);

        // 3. IMPORTANT: Tell RabbitMQ the job is successfully done
        channel.ack(msg);
        log(`[v] Successfully wrote Row: ${data.row} to sheet`);
      } catch (error) {
        process.stderr.write(`[!] Failed to process message: ${error}\n`);

        // Tell RabbitMQ we failed.
        // The 'false' parameter means "do NOT requeue this immediately"
        // (to avoid an infinite loop of instant failures).
        channel.nack(msg, false, false);
      }
    }
  });
}

startWorker();
