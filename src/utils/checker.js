const axios = require("axios");
const logger = require("./logger");

const checkISO = async (isoData) => {
    const valid = {};

    for (const [arch, systems] of Object.entries(isoData)) {
        valid[arch] = {};
        for (const [osName, versions] of Object.entries(systems)) {
            const validVersions = {};
            for (const [version, url] of Object.entries(versions)) {
                try {
                    const response = await axios.head(url, { timeout: 5000, validateStatus: () => true });
                    if (response.status === 200 || response.status === 304) {
                        validVersions[version] = url;
                    } else {
                        logger.warning(`${osName} - ${version} (${url}) returned status ${response.status}`);
                    }
                } catch (err) {
                    logger.error(`${osName} - ${version} not available (${err.message})`);
                }
            }
            if (Object.keys(validVersions).length > 0) {
                valid[arch][osName] = validVersions;
            }
        }
    }

    return valid;
};

module.exports = { checkISO };
