import express from "express";
import { connectRabbitMQ } from "./rabbitmq.js";
import { createClient } from "redis";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

let client;
try {
    client = createClient();
    await client.connect();
    console.log("✅ Successfully connected to redis");
}
catch (error) {
    console.log("❌ Error connecting to redis")
  client = createClient();
  await client.connect();
  console.log("✅ Successfully connected to redis");
} 

const app = express();

app.use(
  cors({
    origin: "http://localhost:3000", // your frontend URL
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.use(express.json());

const QUEUE = "ride-request-queue";

const channel = await connectRabbitMQ(QUEUE);

app.get("/test", (req, res) => {
  res.send("Hello World Test route!");
});

app.get("/status/:rideId", async (req, res) => {
  const key = `rideId:${req.params.rideId}`;

    // {status, rideId, driverId}
    const existingData = await client.get(key);

  if (existingData === null) {
    res.status(404).json({
      msg: "Ride not found!",
    });
    return;
  }

    const rideData = JSON.parse(existingData);
    const response = rideData;

    if (rideData.driverId) {
        const position = await client.geoPos('active_drivers', `driver:${rideData.driverId}`);
        Object.assign(response, { driverPosition: position ? position[0] : null });
    }

    res.status(200).json(response)
})

app.post('/bookRide/:id', async (req, res) => {
    const startTime = Date.now();
    const { src, dest, price, vehicleType } = req.body;

    const rideId = uuidv4();
    const passengerId = req.params.id; // passenger's wallet public address
    const rideData = {
        status: "PENDING",
        rideId
    };

  // Save to Redis with key like "rideId:rideId" [polled for status check]
  await client.set(`rideId:${rideId}`, JSON.stringify(rideData));

    const msg = JSON.stringify({ src, dest, vehicleType, price, passengerId, rideId, startTime });
    channel.sendToQueue(QUEUE, Buffer.from(msg), { persistent: true });

    res.status(200).json({
        rideId,
        msg: "Successfully made ride request"
    })
})

app.post('/acceptRideByDriver/:did/:rideId', async (req, res) => {
    const driverId = req.params.did;
    const rideId = req.params.rideId;

    const { src, dest, vehicleType, price } = req.body;

    let resObj = {
        status: "success",
        msg: "Successfully accepted ride"
    }
    let resStatus = 200;
    //check if driver has the request

  //accept request - set lock
  const result = await client.set(`ride:${rideId}:accepted_by`, driverId, {
    NX: true,
    EX: 60, // 1 min
  });

    const rideData = {
        status: "ASSIGNED",
        src,
        dest,
        price,
        driverId,
        rideId
    };

  await client.set(`rideId:${rideId}`, JSON.stringify(rideData));

  if (result === null) {
    console.log("❌ Ride already assigned to another driver.");

        resObj.status = "failed"
        resObj.msg = "Ride already accepted by another driver!"
        resStatus = 400;
    }
    else {
        console.log(`✅ Driver ${req.params.did} successfully accepted the ride!`);
    }

  res.status(resStatus).json(rideData);
});

app.put("/updateDriverLocation/:did", async (req, res) => {
  const { lat, lng } = req.body;

    let resStatus = 200;
    let resMessage = "Successfully updated driver location";
    try {
        const now = Date.now();
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
    }
    catch (e) {
        resStatus = 500;
        resMessage = "Something went wrong while updating driver location"
    }


    res.status(resStatus).json({
        msg: resMessage
    })
})

app.post('/completeRide/:did/:rideId', async (req, res) => {
    const driverId = req.params.did;
    const rideId = req.params.rideId;

    let resStatus = 200;
    let resMessage = "Ride completed successfully";

    try {
        // Get ride data
        const rideData = await client.get(`rideId:${rideId}`);

        if (!rideData) {
            return res.status(404).json({
                status: "failed",
                msg: "Ride not found"
            });
        }

        const rideInfo = JSON.parse(rideData);

        // Verify this driver is assigned to this ride
        if (rideInfo.driverId !== driverId) {
            return res.status(403).json({
                status: "failed",
                msg: "You are not authorized to complete this ride"
            });
        }

        // Update ride status
        rideInfo.status = "COMPLETED";
        rideInfo.completedAt = Date.now();

        // Save updated ride data
        await client.set(`rideId:${rideId}`, JSON.stringify(rideInfo));

        // Add to completed rides collection
        await client.sAdd("completed_rides", rideId);

        res.status(resStatus).json({
            status: "success",
            msg: resMessage,
            rideId,
            driverId
        });
    } catch (error) {
        console.error("Error completing ride:", error);
        res.status(500).json({
            status: "failed",
            msg: "Failed to complete ride due to server error"
        });
    }
});

app.post('/updateRidePayment/:rideId', async (req, res) => {
    const rideId = req.params.rideId;
    const { txHash, paymentStatus, chainId } = req.body;

    let resStatus = 200;
    let resMessage = "Payment status updated successfully";

    try {
        // Get ride data
        const rideData = await client.get(`rideId:${rideId}`);

        if (!rideData) {
            return res.status(404).json({
                status: "failed",
                msg: "Ride not found"
            });
        }

        const rideInfo = JSON.parse(rideData);

        // Update payment information
        rideInfo.paymentStatus = paymentStatus;
        rideInfo.paymentTxHash = txHash;
        rideInfo.paymentChainId = chainId; // Store the blockchain network ID
        rideInfo.paymentTimestamp = Date.now();

        // Save updated ride data
        await client.set(`rideId:${rideId}`, JSON.stringify(rideInfo));

        // Add to paid rides collection if needed
        if (paymentStatus === "PAID") {
            await client.sAdd("paid_rides", rideId);
        }

        res.status(resStatus).json({
            status: "success",
            msg: resMessage,
            rideId,
            paymentStatus,
            txHash,
            chainId
        });
    } catch (error) {
        console.error("Error updating payment status:", error);
        res.status(500).json({
            status: "failed",
            msg: "Failed to update payment status due to server error"
        });
    }
});

export { app, client };
