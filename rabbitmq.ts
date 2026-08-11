import client from "amqplib";
import { env } from "./env";

type RabbitConnection = Awaited<ReturnType<typeof client.connect>>;
type RabbitChannel = Awaited<ReturnType<RabbitConnection["createChannel"]>>;

export async function getRabbitChannel(): Promise<{
  connection: RabbitConnection;
  channel: RabbitChannel;
}> {
  const connection = await client.connect(
    env.RABBITMQ_URL || "amqp://localhost",
  );
  const channel = await connection.createChannel();

  await channel.assertQueue(env.QUEUE_NAME, {
    durable: true,
  });

  return { connection, channel };
}
