const fs = require("fs");
const https = require("https");
const http = require("http");
const zlib = require("zlib");
const { URL } = require("url");

const agentCache = new Map();

const createHTTP1Agent = (isHttps) => {
    const cacheKey = isHttps ? 'https' : 'http';
    if (agentCache.has(cacheKey)) return agentCache.get(cacheKey);
    const Agent = isHttps ? https.Agent : http.Agent;
    const agent = new Agent({
        keepAlive: true,
        keepAliveMsecs: 1000,
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: 0,
        freeSocketTimeout: 4000,
        scheduling: 'fifo'
    });
    agentCache.set(cacheKey, agent);
    return agent;
};

class HTTP1Downloader {
    constructor(url, isHttps, options = {}) {
        this.url = url;
        this.isHttps = isHttps;
        this.options = options;
        this.agent = createHTTP1Agent(isHttps);
    }

    createRequestHeaders(method, range = null) {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': this.options.useCompression ? 'gzip, deflate, br' : 'identity',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        };

        if (range) {
            headers['Range'] = `bytes=${range}`;
        }

        return headers;
    }

    async followRedirects(url, method = 'HEAD', range = null, maxRedirects = 5) {
        let currentUrl = url;
        let redirectCount = 0;

        while (redirectCount < maxRedirects) {
            const parsedUrl = new URL(currentUrl);
            const isHttps = parsedUrl.protocol === 'https:';
            const requestModule = isHttps ? https : http;
            const agent = createHTTP1Agent(isHttps);

            const result = await new Promise((resolve, reject) => {
                const headers = this.createRequestHeaders(method, range);
                const options = {
                    method,
                    agent,
                    headers,
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port,
                    path: parsedUrl.pathname + parsedUrl.search
                };

                const req = requestModule.request(options, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        const location = res.headers.location;
                        const redirectUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                        resolve({ redirect: true, url: redirectUrl, response: res });
                    } else {
                        resolve({ redirect: false, response: res });
                    }
                });

                req.on('error', reject);
                req.setTimeout(10000, () => { 
                    req.destroy(); 
                    reject(new Error(`${method} request timeout`)); 
                });
                req.end();
            });

            if (result.redirect) {
                currentUrl = result.url;
                redirectCount++;
                continue;
            }

            return { finalUrl: currentUrl, response: result.response };
        }

        throw new Error(`Too many redirects (${maxRedirects})`);
    }

    async getContentInfo() {
        try {
            const { finalUrl, response } = await this.followRedirects(this.url, 'HEAD');
            
            if (response.statusCode >= 200 && response.statusCode < 300) {
                const length = parseInt(response.headers['content-length'] || '0', 10);
                const acceptsRanges = response.headers['accept-ranges'] === 'bytes';
                return { length, acceptsRanges, supportsHTTP2: false, headers: response.headers, finalUrl };
            } else {
                throw new Error(`HTTP ${response.statusCode}`);
            }
        } catch (error) {
            throw error;
        }
    }

    async downloadChunk(start, end, chunkIndex, onProgress, writeCallback) {
        try {
            const { finalUrl } = await this.followRedirects(this.url, 'GET', `${start}-${end}`);
            const parsedUrl = new URL(finalUrl);
            const isHttps = parsedUrl.protocol === 'https:';
            const requestModule = isHttps ? https : http;
            const agent = createHTTP1Agent(isHttps);

            return new Promise((resolve, reject) => {
                const headers = this.createRequestHeaders('GET', `${start}-${end}`);
                const options = {
                    agent,
                    headers,
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port,
                    path: parsedUrl.pathname + parsedUrl.search
                };

                const req = requestModule.get(options, (res) => {
                    if (res.statusCode !== 206 && res.statusCode !== 200) {
                        return reject(new Error(`HTTP ${res.statusCode} for chunk ${chunkIndex}`));
                    }
                    
                    const encoding = res.headers['content-encoding'] || 'identity';
                    let stream = res;
                    
                    if (encoding !== 'identity') {
                        if (encoding.includes('gzip')) {
                            stream = res.pipe(zlib.createGunzip());
                        } else if (encoding.includes('deflate')) {
                            stream = res.pipe(zlib.createInflate());
                        }
                    }
                    
                    stream.on('data', async (chunk) => {
                        try {
                            await writeCallback(chunk);
                            onProgress(chunk.length);
                        } catch (error) {
                            reject(error);
                        }
                    });
                    
                    stream.on('end', () => {
                        resolve({ buffer: Buffer.alloc(0), index: chunkIndex, start });
                    });
                    
                    stream.on('error', reject);
                });
                
                req.on('error', reject);
                req.setTimeout(30000, () => { 
                    req.destroy(); 
                    reject(new Error(`HTTP/1 chunk ${chunkIndex} timeout`)); 
                });
            });
        } catch (error) {
            throw error;
        }
    }

    async downloadSingleStreaming(onProgress, writeCallback) {
        try {
            const { finalUrl } = await this.followRedirects(this.url, 'GET');
            const parsedUrl = new URL(finalUrl);
            const isHttps = parsedUrl.protocol === 'https:';
            const requestModule = isHttps ? https : http;
            const agent = createHTTP1Agent(isHttps);

            return new Promise((resolve, reject) => {
                const headers = this.createRequestHeaders('GET');
                const options = {
                    agent,
                    headers,
                    hostname: parsedUrl.hostname,
                    port: parsedUrl.port,
                    path: parsedUrl.pathname + parsedUrl.search
                };
                
                const req = requestModule.get(options, (res) => {
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }

                    const encoding = res.headers['content-encoding'] || 'identity';
                    let stream = res;
                    
                    if (encoding !== 'identity') {
                        if (encoding.includes('gzip')) {
                            stream = res.pipe(zlib.createGunzip());
                        } else if (encoding.includes('deflate')) {
                            stream = res.pipe(zlib.createInflate());
                        }
                    }
                    
                    stream.on('data', async (chunk) => {
                        try {
                            await writeCallback(chunk);
                            onProgress(chunk.length);
                        } catch (error) {
                            reject(error);
                        }
                    });
                    
                    stream.on('end', () => {
                        resolve();
                    });
                    
                    stream.on('error', reject);
                });
                
                req.on('error', reject);
                req.setTimeout(30000, () => { 
                    req.destroy(); 
                    reject(new Error('HTTP/1 streaming download timeout')); 
                });
            });
        } catch (error) {
            throw error;
        }
    }
}

module.exports = { HTTP1Downloader };