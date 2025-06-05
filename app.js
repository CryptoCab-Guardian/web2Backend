import express from 'express';
import { connectRabbitMQ } from "./rabbitmq.js";
import { createClient } from "redis";
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

let client;
try {
    client = createClient();
    await client.connect();
    console.log("✅ Successfully connected to redis");
} catch (error) {
    console.log("❌ Error connecting to redis")
}

const app = express();

app.use(cors({
    origin: 'http://localhost:3000', // your frontend URL
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
}));

app.use(express.json());

const QUEUE = "ride-request-queue";

const channel = await connectRabbitMQ(QUEUE);

app.get('/test', (req, res) => {
    res.send('Hello World Test route!')
})

app.get('/status/:rideId', async (req, res) => {
    const key = `rideId:${req.params.rideId}`;

    const existingData = await client.get(key);

    if (existingData === null) {
        res.status(404).json({
            msg: "Ride not found!"
        })
        return;
    }

    const ride = JSON.parse(existingData);

    res.status(200).json({
        ride
    })
})

app.post('/bookRide/:id', async (req, res) => {
    const startTime = Date.now();
    const { src, dest } = req.body;
    console.log('New ride request registered. src:', src);
    console.log('dest:', dest);

    const rideId = uuidv4();
    const passengerId = req.params.id;
    const rideData = {
        status: "PENDING",
        // rideId,
        // src,
        // dest,
    };

    // Save to Redis with key like "rideId:rideId" [polled for status check]
    await client.set(`rideId:${rideId}`, JSON.stringify(rideData));

    const msg = JSON.stringify({ src, dest, passengerId, rideId, startTime });
    channel.sendToQueue(QUEUE, Buffer.from(msg), { persistent: true });

    res.status(200).json({
        msg: "Successfully made ride request"
    })
})

app.post('/acceptRideByDriver/:did/:rideId', async (req, res) => {
    const driverId = req.params.did;
    const rideId = req.params.rideId;
    let resObj = {
        status: "success",
        msg: "Successfully accepted ride"
    }
    let resStatus = 200;
    //check if driver has the request

    //accept request - set lock
    const result = await client.set(`ride:${rideId}:accepted_by`, driverId, {
        NX: true,
        EX: 60 // 1 min
    });

    const rideData = {
        driverId,
        status: "ASSIGNED"
    };

    await client.set(`rideId:${rideId}`, JSON.stringify(rideData));

    if (result === null) {
        console.log("❌ Ride already assigned to another driver.");

        resObj.status = "failed"
        resObj.msg = "Ride already accepted by another driver!"
        resStatus = 400;
    } else {
        console.log(`✅ Driver ${req.params.did} successfully accepted the ride!`);
        // Proceed to assign ride to this driver
    }

    res.status(resStatus).json(resObj);
})

app.put('/updateDriverLocation/:did', async (req, res) => {
    const { lat, lng } = req.body;

    let resStatus = 200;
    let resMessage = "Successfully updated driver location";
    try {
        const now = Date.now(); // milliseconds
        await Promise.all([
            client.geoAdd("active_drivers", [{
                longitude: lng,
                latitude: lat,
                member: `driver:${req.params.did}`
            }]),
            client.zAdd("driver_last_updated", {
                score: now,
                value: `driver:${req.params.did}`
            })
        ]);
    } catch (e) {
        resStatus = 500;
        resMessage = "Something went wrong while updating driver location"
        console.log(e);
    }


    res.status(resStatus).json({
        msg: resMessage
    })
})

export { app, client }