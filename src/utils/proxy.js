const axios = require("axios");
const logger = require("./logger");

async function testProxy(host, port, timeout = 10000) {
    try {
        await axios.get("https://www.example.com", {
            proxy: { host, port: parseInt(port) },
            timeout
        });
        return true;
    } catch (err) {
        return false;
    }
}


function checkProxies(proxies, options = {}) {
    const timeout = options.timeout || 10000;
    return Promise.all(proxies.map(async proxyStr => {
        const [host, port] = proxyStr.split(":");
        const alive = await testProxy(host, port, timeout);
        if (alive) { logger.info(`Proxy ${host}:${port} works`); }
        return { host, port, alive };
    }));
}


async function getValidProxy(timeout = 10000) {
    try {
        const response = await axios.get(
            "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=ipport&format=text",
            { timeout: 10000 }
        );

        const proxies = response.data
            .split("\n")
            .map(p => p.trim())
            .filter(p => p.length > 0);

        logger.info(`Fetched ${proxies.length} proxies`);

        const results = await checkProxies(proxies, { timeout });

        for (const proxy of results) {
            if (proxy.alive) {
                return `${proxy.host}:${proxy.port}`;
            } else {}
        }

        logger.error("No valid proxy found after checking all proxies.");
    } catch (err) {
        logger.error("Error while fetching or checking proxies: " + err.message);
    }

    throw new Error("No valid proxy could be found.");
}

module.exports = { getValidProxy };
