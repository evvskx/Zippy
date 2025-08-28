const axios = require("axios");
const iso = require("../data/options.json");

const checkISO = async () => {
    const requests = [];

    for (const [arch, entries] of Object.entries(iso)) {
        for (const [name, url] of Object.entries(entries)) {
            requests.push((async () => {
                try {
                    const response = await axios.head(url, { timeout: 5000, validateStatus: () => true });
                    if (!(response.status === 200 || response.status === 304)) {
                        logger.warning(`${name} - ${url} returned status ${response.status}`);
                    }
                } catch (err) {
                    logger.error(`${name}'s download not available (${err.message})`);
                }
            })());
        }
    }

    await Promise.all(requests);
};

module.exports = { checkISO };
