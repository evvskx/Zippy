const fs = require("fs");
const https = require("https");
const http = require("http");
const zlib = require("zlib");

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

    async getContentInfo() {
        const requestModule = this.isHttps ? https : http;
        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('HEAD');
            const req = requestModule.request(this.url, { method: 'HEAD', agent: this.agent, headers }, (res) => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    const length = parseInt(res.headers['content-length'] || '0', 10);
                    const acceptsRanges = res.headers['accept-ranges'] === 'bytes';
                    resolve({ length, acceptsRanges, supportsHTTP2: false, headers: res.headers });
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });
            req.on('error', reject);
            req.setTimeout(10000, () => { 
                req.destroy(); 
                reject(new Error('HEAD request timeout')); 
            });
            req.end();
        });
    }

    async downloadChunk(start, end, chunkIndex, onProgress, writeCallback) {
        const requestModule = this.isHttps ? https : http;
        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET', `${start}-${end}`);
            const req = requestModule.get(this.url, { agent: this.agent, headers }, (res) => {
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
    }

    async downloadSingleStreaming(onProgress, writeCallback) {
        const requestModule = this.isHttps ? https : http;

        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET');
            
            const req = requestModule.get(this.url, { agent: this.agent, headers }, (res) => {
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
    }
}

module.exports = { HTTP1Downloader };