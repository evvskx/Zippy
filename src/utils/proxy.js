const axios = require("axios");
const logger = require("./logger");
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

async function testProxySimple(host, port, timeout = 1500) {
    try {
        const response = await axios.get("https://ipapi.co/ip/", {
            proxy: { host, port: parseInt(port) },
            timeout,
            headers: { 'User-Agent': 'curl/7.68.0' },
            maxRedirects: 0
        });
        
        const ip = response.data.trim();
        return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) ? ip : false;
    } catch (err) {
        return false;
    }
}

const testProxy = testProxySimple;

function preFilterProxies(proxies) {
    return proxies.filter(proxy => {
        
        if (!proxy.ip || !proxy.port) {
            return false;
        }
        
        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
        if (!ipRegex.test(proxy.ip)) {
            return false;
        }
        
        const portNum = parseInt(proxy.port);
        if (portNum < 1 || portNum > 65535) {
            return false;
        }
        
        return true;
    });
}

function sortProxiesByQuality(proxies) {
    return proxies.sort((a, b) => {
        const timeoutA = a.average_timeout || 5000;
        const timeoutB = b.average_timeout || 5000;
        
        if (timeoutA !== timeoutB) {
            return timeoutA - timeoutB;
        }
        
        const anonymityScore = { elite: 3, anonymous: 2, transparent: 1 };
        const scoreA = anonymityScore[a.anonymity] || 0;
        const scoreB = anonymityScore[b.anonymity] || 0;
        
        return scoreB - scoreA;
    });
}

async function checkProxiesConcurrent(proxies, options = {}) {
    const timeout = options.timeout || 5000;
    const maxConcurrent = options.maxConcurrent || 100;
    const earlyExit = options.earlyExit || false;
    const maxFound = options.maxFound || 1;
    
    const results = [];
    const semaphore = new Array(maxConcurrent).fill(null);
    let activeRequests = 0;
    let foundCount = 0;
    let index = 0;

    const processProxy = async (proxy) => {
        const host = proxy.ip || proxy.host;
        const port = proxy.port;
        
        const alive = await testProxy(host, port, timeout);
        
        if (alive) { 
            logger.info(`Proxy ${host}:${port} works - Location: ${proxy.country || 'Unknown'}, Timeout: ${proxy.average_timeout || 'N/A'}ms`);
            foundCount++;
        }
        
        return { 
            host, 
            port, 
            alive,
            country: proxy.country,
            anonymity: proxy.anonymity,
            avgTimeout: proxy.average_timeout
        };
    };

    return new Promise((resolve, reject) => {
        const checkNext = async () => {
            if (earlyExit && foundCount >= maxFound) {
                resolve(results.filter(r => r.alive));
                return;
            }

            if (index >= proxies.length) {
                if (activeRequests === 0) {
                    resolve(results);
                }
                return;
            }

            if (activeRequests >= maxConcurrent) {
                return;
            }

            const currentIndex = index++;
            const proxy = proxies[currentIndex];
            activeRequests++;

            try {
                const result = await processProxy(proxy);
                results.push(result);
                
                if (result.alive && earlyExit && foundCount >= maxFound) {
                    resolve(results.filter(r => r.alive));
                    return;
                }
            } catch (error) {
                logger.warning(`Error testing proxy ${proxy.ip}:${proxy.port}: ${error.message}`);
            } finally {
                activeRequests--;
                setImmediate(checkNext);
            }

            setImmediate(checkNext);
        };

        for (let i = 0; i < Math.min(maxConcurrent, proxies.length); i++) {
            checkNext();
        }
    });
}

async function checkProxiesWithWorkers(proxies, options = {}) {
    const numWorkers = options.numWorkers || require('os').cpus().length;
    const chunkSize = Math.ceil(proxies.length / numWorkers);
    const workers = [];
    const results = [];

    return new Promise((resolve, reject) => {
        let completedWorkers = 0;

        for (let i = 0; i < numWorkers; i++) {
            const startIndex = i * chunkSize;
            const endIndex = Math.min(startIndex + chunkSize, proxies.length);
            const chunk = proxies.slice(startIndex, endIndex);

            if (chunk.length === 0) break;

            const worker = new Worker(__filename, {
                workerData: { 
                    proxies: chunk, 
                    timeout: options.timeout || 5000,
                    isWorker: true
                }
            });

            worker.on('message', (workerResults) => {
                results.push(...workerResults);
                completedWorkers++;

                if (completedWorkers === workers.length) {
                    resolve(results);
                }
            });

            worker.on('error', reject);
            workers.push(worker);
        }
    });
}

async function getValidProxy(timeout = 1000, options = {}) {
    const proxySourcesUrls = [
        // i didnt want to do this... but hey, if it works it works
        "https://api.proxyscrape.com/v2/?request=display_proxies&format=textplain&protocol=http&timeout=1000&country=all&ssl=all&anonymity=all",
        "https://www.proxy-list.download/api/v1/get?type=http",
        "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
        "https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt",
        "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
        "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
        "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt",
        "https://api.openproxylist.xyz/http.txt",
        "https://raw.githubusercontent.com/hendrikbgr/Free-Proxy-Repo/master/proxy_list.txt"
    ];

    let allProxies = [];
    let sourceCount = 0;
    
    const sourcePromises = proxySourcesUrls.map(async (url) => {
        try {
            logger.info(`Fetching from: ${url.split('/')[2]}`);
            const response = await axios.get(url, { 
                timeout: 8000,
                headers: { 'User-Agent': 'curl/7.68.0' }
            });
            
            if (!response.data) return [];
            
            const textProxies = response.data
                .split("\n")
                .map(p => p.trim())
                .filter(p => p.length > 0 && p.includes(':') && !p.startsWith('#'))
                .slice(0, 1000); 
            
            const proxies = textProxies.map(proxyStr => {
                const [ip, port] = proxyStr.split(":");
                return { ip, port: parseInt(port), source: url.split('/')[2] };
            }).filter(p => p.ip && p.port && p.port > 0 && p.port < 65536);
            
            if (proxies.length > 0) {
                sourceCount++;
                logger.info(`Got ${proxies.length} from ${url.split('/')[2]}`);
                return proxies;
            }
            return [];
            
        } catch (err) {
            logger.warning(`Failed ${url.split('/')[2]}: ${err.message}`);
            return [];
        }
    });
    
    const results = await Promise.all(sourcePromises);
    results.forEach(proxies => allProxies.push(...proxies));
    
    if (allProxies.length === 0) {
        throw new Error("Could not fetch any proxies from any source");
    }

    logger.info(`Collected ${allProxies.length} proxies from ${sourceCount} sources`);

    const uniqueProxies = allProxies.filter((proxy, index, self) => 
        index === self.findIndex(p => p.ip === proxy.ip && p.port === proxy.port)
    );

    logger.info(`Unique proxies: ${uniqueProxies.length}`);

    const validProxies = uniqueProxies.filter(proxy => {
        const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
        return ipRegex.test(proxy.ip) && proxy.port > 0 && proxy.port < 65536;
    });

    logger.info(`Valid format proxies: ${validProxies.length}`);
    
    const shuffled = validProxies.sort(() => Math.random() - 0.5);
    const testLimit = Math.min(500, shuffled.length);
    const proxiesToTest = shuffled.slice(0, testLimit);
    
    logger.info(`Testing ${proxiesToTest.length} random proxies...`);

    const results2 = await checkProxiesConcurrent(proxiesToTest, { 
        timeout,
        maxConcurrent: 300,
        earlyExit: true,
        maxFound: 1
    });

    const workingProxies = results2.filter(r => r.alive);
    logger.info(`Found ${workingProxies.length} working proxies`);

    if (workingProxies.length > 0) {
        const proxy = workingProxies[0];
        logger.info(`Using proxy: ${proxy.host}:${proxy.port} (IP: ${proxy.returnedIp})`);
        return `${proxy.host}:${proxy.port}`;
    }

    logger.warning("No proxies found, trying emergency sources...");
    
    try {
        const emergencyUrl = "https://raw.githubusercontent.com/fate0/proxylist/master/proxy.list";
        const response = await axios.get(emergencyUrl, { timeout: 5000 });
        
        const jsonProxies = response.data
            .split('\n')
            .filter(line => line.trim())
            .map(line => {
                try {
                    const data = JSON.parse(line);
                    return { ip: data.host, port: data.port };
                } catch {
                    return null;
                }
            })
            .filter(p => p && p.ip && p.port)
            .slice(0, 200);

        if (jsonProxies.length > 0) {
            logger.info(`Emergency testing ${jsonProxies.length} proxies...`);
            
            const emergencyResults = await checkProxiesConcurrent(jsonProxies, { 
                timeout: 800,
                maxConcurrent: 400,
                earlyExit: true,
                maxFound: 1
            });

            const emergencyWorking = emergencyResults.filter(r => r.alive);
            
            if (emergencyWorking.length > 0) {
                const proxy = emergencyWorking[0];
                logger.info(`Emergency proxy found: ${proxy.host}:${proxy.port}`);
                return `${proxy.host}:${proxy.port}`;
            }
        }
        
    } catch (err) {
        logger.warning(`Emergency source failed: ${err.message}`);
    }

    logger.error("No valid proxy found after testing all sources and emergency backup.");
    return null;
}

async function getMultipleValidProxies(count = 3, timeout = 1500) {
    try {
        let proxies; 
        logger.info("Fetching fresh proxy list for multiple proxies...");
        
        const response = await axios.get(
            "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&format=json",
            { timeout: 15000 }
        );

        proxies = response.data.proxies || response.data;
        
        if (!Array.isArray(proxies)) {
            throw new Error("Invalid response format from ProxyScrape API");
        }

        const filteredProxies = preFilterProxies(proxies);
        const sortedProxies = sortProxiesByQuality(filteredProxies);
        const proxiesToTest = sortedProxies.slice(0, count * 10);
        
        logger.info(`Testing ${proxiesToTest.length} proxies for ${count} valid ones...`);

        const results = await checkProxiesConcurrent(proxiesToTest, { 
            timeout,
            maxConcurrent: 150,
            earlyExit: true,
            maxFound: count
        });

        const validProxies = results
            .filter(r => r.alive)
            .map(r => `${r.host}:${r.port}`)
            .slice(0, count);

        logger.info(`Found ${validProxies.length}/${count} valid proxies`);
        return validProxies;
        
    } catch (err) {
        logger.error("Error getting multiple proxies: " + err.message);
        return [];
    }
}

if (!isMainThread && workerData && workerData.isWorker) {
    (async () => {
        const results = [];
        const { proxies, timeout } = workerData;
        
        for (const proxy of proxies) {
            const host = proxy.ip || proxy.host;
            const port = proxy.port;
            
            const alive = await testProxySimple(host, port, timeout);
            
            results.push({ 
                host, 
                port, 
                alive: !!alive,
                returnedIp: alive,
                country: proxy.country,
                anonymity: proxy.anonymity,
                avgTimeout: proxy.average_timeout
            });
        }
        
        parentPort.postMessage(results);
    })();
}

module.exports = { getValidProxy, getMultipleValidProxies };

if (require.main === module && isMainThread) {
    (async () => {
        const proxy = await getValidProxy(5000, { 
            maxConcurrent: 100, 
            earlyExit: true,
            useWorkers: true
        });
        console.log("Found proxy:", proxy);
    })();
}