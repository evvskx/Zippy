const axios = require("axios");
const logger = require("./logger");

const checkISO = async (isoData = null) => {
    if (!isoData) {
        const iso = require("../data/options.json");
        isoData = iso;
    }

    const requests = [];
    const validISOs = {};

    for (const [arch, osEntries] of Object.entries(isoData)) {
        validISOs[arch] = {};
        
        for (const [osName, distributions] of Object.entries(osEntries)) {
            validISOs[arch][osName] = {};
            
            for (const [distroName, url] of Object.entries(distributions)) {
                requests.push((async () => {
                    try {
                        const response = await axios.head(url, {
                            timeout: 5000,
                            maxRedirects: 5,
                            validateStatus: () => true
                        });

                        if (response.status === 200 || response.status === 304) {
                            let finalUrl = url;

                            if (response.request?.res?.responseUrl) {
                                finalUrl = response.request.res.responseUrl;
                            }

                            validISOs[arch][osName][distroName] = finalUrl;
                        } else {
                            logger.warning(`${arch}/${osName}/${distroName} - ${url} returned status ${response.status}`);
                        }
                    } catch (err) {
                        logger.error(`${arch}/${osName}/${distroName}'s download not available (${err.message})`);
                    }
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
