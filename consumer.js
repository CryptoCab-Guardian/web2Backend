import { connectRabbitMQ } from "./rabbitmq.js";
import { createClient } from "redis";

let client;
let pubSubClient;

try {
    client = createClient();
    await client.connect();
    client.on('error', (err) => {
        console.error('❌ Redis client error:', err);
    });

    pubSubClient = createClient();
    await pubSubClient.connect();
    pubSubClient.on('error', (err) => {
        console.error('❌ Redis pubsub client error:', err.message);
    });


    console.log("✅ Successfully connected to redis");
} catch (error) {
    console.log("❌ Error connecting to redis", error)
}


const QUEUE = "ride-request-queue";

const channel = await connectRabbitMQ(QUEUE);

channel.consume(QUEUE, async (msg) => {
    if (msg !== null) {
        try {
            const { rideId, src, dest, passengerId } = JSON.parse(msg.content.toString());
            console.log(`ride request src:${JSON.stringify(src)} dest:${JSON.stringify(dest)} received`);

            const results = await client.geoSearchWith('active_drivers',
                { latitude: Number(src.lat), longitude: Number(src.lng) },
                { radius: 50, unit: 'km' },
                ['WITHDIST', 'WITHCOORD'],
                { SORT: 'ASC', COUNT: 5 });


            if (results.length === 0) {
                console.log("❌ No drivers available nearby.");
                channel.nack(msg); // requeue = true by default
                console.log(`requeued ride request with src:${JSON.stringify(src)} dest:${JSON.stringify(dest)}`)
            } else {
                console.log("🔎 Nearby drivers found:");

                results.forEach(async ({ member: driverId, distance }) => {
                    console.log(`- ${driverId} (${Number(distance).toFixed(2)} km away)`);

                    await pubSubClient.publish('ride-requests', JSON.stringify({
                        rideId,
                        driverId,
                        passengerId,
                        src,
                        dest,
                        distance: Number(distance).toFixed(2),
                    }));

                    console.log(`📨 Published ride request ${rideId} for driver ${driverId}`);
                }
                )
                channel.ack(msg);
            }
        } catch (error) {
            console.error('⚠️ Error while processing ride request:', error);

            if (error.message.includes('invalid longitude,latitude pair')) {
                console.log('⚠️ Bad coordinates received, discarding message.');
                channel.ack(msg);
            } else {
                console.log('⚠️ Unexpected error, requeueing message...');
                channel.nack(msg, false, true); // requeue = true
            }
        }

    }
})