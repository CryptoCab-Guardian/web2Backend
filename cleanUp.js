import { client } from "./app.js";

const redisCleanUp = () => {
    setInterval(async () => {
        const TWO_MINUTES_AGO = Date.now() - 2 * 60 * 1000;

        // Get inactive drivers
        const staleDrivers = await client.zRangeByScore("driver_last_updated", 0, TWO_MINUTES_AGO);

        if (staleDrivers.length > 0) {
            console.log(`⏳ Removing inactive drivers:`, staleDrivers);

            // Remove from GEO set
            await client.zRem("active_drivers", staleDrivers);

            // Remove from timestamp tracking set
            await client.zRem("driver_last_updated", staleDrivers);
        }
    }, 30000); // every 30s
}

export { redisCleanUp };