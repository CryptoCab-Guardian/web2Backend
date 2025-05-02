import express from 'express';
import { connectRabbitMQ } from "./rabbitmq.js";
import { createClient } from "redis";
import cors from 'cors';

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

app.post('/bookRide', (req, res) => {
    const { src, dest } = req.body;
    console.log('New ride request registered. src:', src);
    console.log('dest:', dest);

    const msg = JSON.stringify({ src, dest });
    channel.sendToQueue(QUEUE, Buffer.from(msg), { persistent: true });

    res.status(200).json({
        msg: "Successfully made ride request"
    })
})

app.post('/acceptRideByDriver/:did/:rideId', async (req, res) => {
    let resObj = {
        status: "success",
        msg: "Successfully accepted ride"
    }
    let resStatus = 200;
    //check if driver has the request

    //accept request
    const result = await client.set(`ride:${req.params.rideId}:accepted_by`, req.params.did, {
        NX: true,
        EX: 60 // 1 min
    });

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
        await client.geoAdd("active_drivers", [{
            longitude: lng,
            latitude: lat,
            member: `driver:${req.params.did}`
        }]);
    } catch (e) {
        resStatus = 500;
        resMessage = "Something went wrong while updating driver location"
        console.log(e);
    }


    res.status(resStatus).json({
        msg: resMessage
    })
})

export { app }