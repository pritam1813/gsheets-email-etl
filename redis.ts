import { RedisClient } from "bun";
import { env } from "./env";

export const publisher = new RedisClient(env.REDIS_URL);
export const subscriber = await publisher.duplicate();
