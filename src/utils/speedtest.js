const https = require("https");
const logger = require("./logger");

async function getRecommendedBuffer() {
    return new Promise((resolve, reject) => {
        const url = "https://speed.hetzner.de/100MB.bin";
        logger.info("Starting speed test with Hetzner file...");

        const start = Date.now();
        let downloaded = 0;

        const options = { rejectUnauthorized: false };

        https.get(url, options, (res) => {
            logger.info(`Status Code: ${res.statusCode}`);
            logger.info(`Content-Length: ${res.headers["content-length"]}`);

            res.on("data", (chunk) => {
                downloaded += chunk.length;
                logger.info(`Downloaded ${downloaded} bytes so far...`);
            });

            res.on("end", () => {
                const duration = (Date.now() - start) / 1000;
                const speedMbps = (downloaded * 8) / (duration * 1e6);
                logger.info(`Total downloaded: ${downloaded} bytes`);
                logger.info(`Duration: ${duration.toFixed(2)} s`);
                logger.info(`Calculated speed: ${speedMbps.toFixed(2)} Mbps`);

                let recommendedBuffer;
                if (speedMbps < 1) recommendedBuffer = 16 * 1024;
                else if (speedMbps < 5) recommendedBuffer = 32 * 1024;
                else if (speedMbps < 20) recommendedBuffer = 64 * 1024;
                else recommendedBuffer = 128 * 1024;

                logger.info(`Recommended buffer: ${recommendedBuffer} bytes`);
                resolve(recommendedBuffer);
            });
        }).on("error", (err) => {
            logger.error(`Error during speed test: ${err.message}`);
            reject(err);
        });
    });
}

module.exports = { getRecommendedBuffer };
