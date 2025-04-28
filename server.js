import { createServer } from 'http';
import { app } from './app.js';
import WebSocket, { WebSocketServer } from "ws";
import { createClient } from "redis";

let client;
const PORT = 7777;
const httpServer = createServer(app);
let driverSockets = new Map();

// Start HTTP server first
httpServer.listen(PORT, async () => {
    console.log(`🚀 Server listening on http://localhost:${PORT}`);

    // Only after HTTP server is ready, setup WebSocket server
    await setupWebSocketServer(httpServer);
});

// Handle HTTP server error
httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Please use a different port.`);
    } else {
        console.error('❌ Server error:', err);
    }
});

try {
    client = createClient();
    await client.connect();
    client.on('error', (err) => {
        console.error('❌ Redis client error:', err.message);
    });

    client.subscribe('ride-requests', async (message) => {
        try {
            const { rideId, driverId, src, dest, distance } = JSON.parse(message);

            const socket = driverSockets.get(driverId);
            // console.log("get result: ", socket);

            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'NEW_RIDE_REQUEST',
                    rideId,
                    src,
                    dest,
                    distance,
                }));
                console.log(`📨 Sent ride request to driver ${driverId}`);
            } else {
                console.log(`⚠️ Driver ${driverId} not connected via WebSocket.`);
            }
        } catch (error) {
            console.error('Error handling ride request message:', error.message);
        }
    });

    console.log("✅ Successfully connected to redis");
} catch (error) {
    console.log("❌ Error connecting to redis")
}




async function setupWebSocketServer(httpServer) {
    const wss = new WebSocketServer({ server: httpServer });
    console.log("✅ Successfully created WebSocket Server");

    wss.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`❌ WebSocket port is already in use. WebSocket Server not started.`);
        } else {
            console.error('❌ WebSocket Server error:', err);
        }
    });

    wss.on('connection', (socket) => {
        console.log('A driver connected');

        socket.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                if (data.type === 'IDENTIFY') {
                    // const driverId = data.driverId;
                    const driverId = `driver:${data.driverId.trim()}`;
                    driverSockets.set(driverId, socket);
                    console.log(`✅ Driver ${driverId} registered.`);
                }
            } catch (error) {
                console.error('Invalid WebSocket message:', error.message);
            }
        });

        socket.on('close', () => {
            for (const [driverId, ws] of driverSockets.entries()) {
                if (ws === socket) {
                    driverSockets.delete(driverId);
                    console.log(`❌ Driver ${driverId} disconnected`);
                    break;
                }
            }
        });
    });
}

// export { driverSockets };