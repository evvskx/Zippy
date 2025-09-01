const axios = require("axios");
const logger = require("./logger");

const checkISO = async (isoUrl = "https://evvskx.github.io/Zippy/urls.json") => {
    let isoData;
    try {
        const response = await axios.get(isoUrl, { timeout: 1500 });
        isoData = response.data;
    } catch (err) {
        logger.error(`Failed to load ISO data from ${isoUrl} (${err.message})`);
        return {};
    }

    const requests = [];
    const validISOs = {};

    for (const [arch, osEntries] of Object.entries(isoData)) {
        validISOs[arch] = {};

        for (const [osName, distributions] of Object.entries(osEntries)) {
            validISOs[arch][osName] = {};

            for (const [distroName, distroUrl] of Object.entries(distributions)) {
                requests.push((async () => {
                    try {
                        const response = await axios.head(distroUrl, {
                            timeout: 2500,
                            maxRedirects: 5,
                            validateStatus: () => true
                        });

                        if (response.status === 200 || response.status === 304) {
                            let finalUrl = distroUrl;

                            if (response.request?.res?.responseUrl) {
                                finalUrl = response.request.res.responseUrl;
                            }

                            validISOs[arch][osName][distroName] = finalUrl;
                        } else {}
                    } catch (err) {}
                })());
            }
        }
    }

    await Promise.all(requests);

    for (const [arch, osEntries] of Object.entries(validISOs)) {
        for (const [osName, distributions] of Object.entries(osEntries)) {
            if (Object.keys(distributions).length === 0) {
                delete validISOs[arch][osName];
            }
        }
        if (Object.keys(validISOs[arch]).length === 0) {
            delete validISOs[arch];
        }
    }

    return validISOs;
};

module.exports = { checkISO };

if (require.main === module) {
    (async () => {
        const validISOs = await checkISO();
        console.log("Valid ISOs:", validISOs);
    })();
}
