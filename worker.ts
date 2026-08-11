// worker.ts
import { getRabbitChannel } from "./rabbitmq";
import { env } from "./env";
import { enrichWebsiteFromWeb } from "./scraper";
// import { enrichWebsiteFromWeb } from "./your-scraping-logic";
// import { updateSingleSheetRow } from "./your-sheets-logic";

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
        console.log(`[x] Received task for Row: ${data.row}`);

        // 1. Do the heavy lifting (Web search, API calls, etc.)
        const website = await enrichWebsiteFromWeb(data);

        console.log("Proccesed data: ", website);

        // 2. Update Google Sheet for this specific row
        // await updateSingleSheetRow(data.row, website);

        // 3. IMPORTANT: Tell RabbitMQ the job is successfully done
        channel.ack(msg);
        console.log(`[v] Successfully processed Row: ${data.row}`);
      } catch (error) {
        console.error(`[!] Failed to process message:`, error);

        // Tell RabbitMQ we failed.
        // The 'false' parameter means "do NOT requeue this immediately"
        // (to avoid an infinite loop of instant failures).
        channel.nack(msg, false, false);
      }
    }
  });
}

startWorker();
