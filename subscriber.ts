import { env } from "./env";
import { publisher } from "./redis";

await publisher.connect();

await publisher.subscribe(env.REDIS_CHANNEL, (message, channel) => {
  console.log(`Received: ${message}`);
});
