const fs = require("fs");
const http2 = require("http2");
const https = require("https");
const http = require("http");
const util = require("util");
const crypto = require("crypto");
const logger = require("./logger");
const path = require("path");
const { URL } = require("url");
const zlib = require("zlib");

const CHUNK_SIZE = 256 * 1024;
const PARALLEL_CONNECTIONS = 8;
const BUFFER_SIZE = 64 * 1024 * 1024;
const TCP_WINDOW_SIZE = 1048576;
const PROGRESS_UPDATE_INTERVAL = 100;
const PROGRESS_SAVE_INTERVAL = 5000;
const TEMP_EXTENSION = '.tmp';
const PROGRESS_EXTENSION = '.crdownload';

const http2SessionCache = new Map();
const agentCache = new Map();

const gunzipAsync = util.promisify(zlib.gunzip);
const inflateAsync = util.promisify(zlib.inflate);
const brotliDecompressAsync = util.promisify(zlib.brotliDecompress);

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

class Downloader {
    constructor(url, filename, options = {}) {
        this.url = url;
        this.filename = filename;
        this.options = {
            connections: PARALLEL_CONNECTIONS,
            bufferSize: BUFFER_SIZE,
            useHTTP2: true,
            useCompression: true,
            ...options
        };
        
        this.totalBytes = 0;
        this.downloadedBytes = 0;
        this.startTime = Date.now();
        this.hash = crypto.createHash("sha256");
        this.lastUpdate = 0;
        this.lastProgressSave = 0;
        this.lastProgressLength = 0;
        this.parsedUrl = new URL(this.url);
        this.isHttps = this.parsedUrl.protocol === 'https:';
        
        this.tempPath = '';
        this.progressPath = '';
        this.progressData = null;
    }

    formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    formatSpeed(bytesPerSecond) {
        if (bytesPerSecond === 0) return '0 B/s';
        const k = 1024;
        const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
        const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
        return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    updateProgress(forceSave = false) {
        if (this.totalBytes === 0) return;
        
        const now = Date.now();
        const elapsed = (now - this.startTime) / 1000;
        const speedBytesPerSec = this.downloadedBytes / elapsed;
        const percent = (this.downloadedBytes / this.totalBytes * 100);
        const etaSeconds = elapsed > 0 ? (this.totalBytes - this.downloadedBytes) / speedBytesPerSec : 0;

        const days = Math.floor(etaSeconds / 86400);
        const hours = Math.floor((etaSeconds % 86400) / 3600);
        const minutes = Math.floor((etaSeconds % 3600) / 60);
        const seconds = Math.floor(etaSeconds % 60);

        let etaParts = [];
        if (days > 0) etaParts.push(`${days}d`);
        if (hours > 0) etaParts.push(`${hours}h`);
        if (minutes > 0) etaParts.push(`${minutes}m`);
        if (seconds > 0 || etaParts.length === 0) etaParts.push(`${seconds}s`);

        const etaFormatted = etaParts.join(' ');

        const barLength = 30;
        const filled = Math.min(barLength, Math.floor(percent / 100 * barLength));
        const bar = "=".repeat(filled) + " ".repeat(barLength - filled);

        const progressText = `[${bar}] ${percent.toFixed(1)}% | ` +
            `${this.formatBytes(this.downloadedBytes)} / ${this.formatBytes(this.totalBytes)} | ` +
            `${this.formatSpeed(speedBytesPerSec)} | ETA: ${etaFormatted}`;

        
        process.stdout.write('\r' + progressText + ' '.repeat(Math.max(0, (this.lastProgressLength || 0) - progressText.length)));
        this.lastProgressLength = progressText.length;

        if (forceSave || (now - this.lastProgressSave > PROGRESS_SAVE_INTERVAL)) {
            this.saveProgress();
            this.lastProgressSave = now;
        }
    }

    saveProgress() {
        if (!this.progressPath || this.totalBytes === 0) return;
        
        try {
            const progressInfo = {
                url: this.url,
                totalBytes: this.totalBytes,
                downloadedBytes: this.downloadedBytes,
                timestamp: Date.now(),
                tempPath: this.tempPath
            };
            fs.writeFileSync(this.progressPath, JSON.stringify(progressInfo, null, 2));
        } catch (error) {
        }
    }

    loadProgress() {
        if (!this.progressPath || !fs.existsSync(this.progressPath)) return null;
        
        try {
            const data = JSON.parse(fs.readFileSync(this.progressPath, 'utf8'));
            if (data.url === this.url && data.totalBytes > 0) {
                return data;
            }
        } catch (error) {
        }
        return null;
    }

    cleanupProgress() {
        if (this.progressPath && fs.existsSync(this.progressPath)) {
            try {
                fs.unlinkSync(this.progressPath);
            } catch (error) {
            }
        }
    }

    async getHTTP2Session() {
        const authority = `${this.parsedUrl.protocol}//${this.parsedUrl.hostname}:${this.parsedUrl.port || (this.isHttps ? 443 : 80)}`;
        
        let session = http2SessionCache.get(authority);
        if (session && !session.destroyed) return session;
        
        if (session) http2SessionCache.delete(authority);

        session = http2.connect(authority, {
            settings: {
                headerTableSize: 65536,
                enablePush: false,
                maxConcurrentStreams: 100,
                initialWindowSize: TCP_WINDOW_SIZE,
                maxFrameSize: 16777215,
                maxHeaderListSize: 8192
            }
        });

        session.setMaxListeners(100);
        http2SessionCache.set(authority, session);

        return new Promise((resolve, reject) => {
            session.on('connect', () => resolve(session));
            session.on('error', reject);
            session.setTimeout(30000, () => {
                session.destroy();
                reject(new Error('HTTP/2 connection timeout'));
            });
        });
    }

    async checkHTTP2Support() {
        if (!this.options.useHTTP2 || !this.isHttps) return { supportsHTTP2: false };

        try {
            const session = await this.getHTTP2Session();
            return new Promise((resolve) => {
                const req = session.request(this.createRequestHeaders('HEAD'));
                let statusCode, headers = {};

                req.on('response', (responseHeaders) => {
                    statusCode = responseHeaders[':status'];
                    headers = responseHeaders;
                });

                req.on('end', () => {
                    const length = parseInt(headers['content-length'] || '0', 10);
                    const acceptsRanges = headers['accept-ranges'] === 'bytes';
                    resolve({ 
                        supportsHTTP2: statusCode >= 200 && statusCode < 300,
                        length, 
                        acceptsRanges,
                        headers 
                    });
                });

                req.on('error', () => resolve({ supportsHTTP2: false }));
                req.setTimeout(10000, () => {
                    req.destroy();
                    resolve({ supportsHTTP2: false });
                });
                req.end();
            });
        } catch {
            return { supportsHTTP2: false };
        }
    }

    createRequestHeaders(method, range = null) {
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': this.options.useCompression ? 'gzip, deflate, br' : 'identity',
            'Cache-Control': 'no-cache'
        };

        if (method === 'HEAD' || method === 'GET') {
            if (method === 'HEAD') {
                headers[':method'] = 'HEAD';
                headers[':path'] = this.parsedUrl.pathname + this.parsedUrl.search;
            } else {
                headers['Connection'] = 'keep-alive';
            }
        }

        if (range) {
            const rangeHeader = this.options.useHTTP2 ? 'range' : 'Range';
            headers[rangeHeader] = `bytes=${range}`;
        }

        return headers;
    }

    async getContentInfoHTTP1() {
        const requestModule = this.isHttps ? https : http;
        const agent = createHTTP1Agent(this.isHttps);

        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('HEAD');
            delete headers[':method'];
            delete headers[':path'];

            const req = requestModule.request(this.url, { method: 'HEAD', agent, headers }, (res) => {
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

    async decompressBuffer(buffer, encoding) {
        if (encoding === 'identity') return buffer;
        
        switch (true) {
            case encoding.includes('gzip'):
                return await gunzipAsync(buffer);
            case encoding.includes('deflate'):
                return await inflateAsync(buffer);
            case encoding.includes('br'):
                return await brotliDecompressAsync(buffer);
            default:
                return buffer;
        }
    }

    async downloadChunkHTTP2(session, start, end, chunkIndex) {
        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET', `${start}-${end}`);
            headers[':method'] = 'GET';
            headers[':path'] = this.parsedUrl.pathname + this.parsedUrl.search;

            const req = session.request(headers);
            const chunks = [];
            let encoding = 'identity';

            req.on('response', (responseHeaders) => {
                const status = responseHeaders[':status'];
                if (status !== 206 && status !== 200) {
                    return reject(new Error(`HTTP ${status} for chunk ${chunkIndex}`));
                }
                encoding = responseHeaders['content-encoding'] || 'identity';
            });

            req.on('data', (chunk) => {
                chunks.push(chunk);
                this.downloadedBytes += chunk.length;
                
                const now = Date.now();
                if (now - this.lastUpdate > PROGRESS_UPDATE_INTERVAL) {
                    this.updateProgress();
                    this.lastUpdate = now;
                }
            });

            req.on('end', async () => {
                try {
                    const buffer = await this.decompressBuffer(Buffer.concat(chunks), encoding);
                    resolve({ buffer, index: chunkIndex, start });
                } catch (err) {
                    reject(err);
                }
            });

            req.on('error', reject);
            req.setTimeout(30000, () => {
                req.destroy();
                reject(new Error(`HTTP/2 chunk ${chunkIndex} timeout`));
            });
        });
    }

    async downloadChunkHTTP1(start, end, chunkIndex) {
        const requestModule = this.isHttps ? https : http;
        const agent = createHTTP1Agent(this.isHttps);

        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET', `${start}-${end}`);
            delete headers[':method'];
            delete headers[':path'];

            const req = requestModule.get(this.url, { agent, headers }, (res) => {
                if (res.statusCode !== 206 && res.statusCode !== 200) {
                    return reject(new Error(`HTTP ${res.statusCode} for chunk ${chunkIndex}`));
                }

                const chunks = [];
                const encoding = res.headers['content-encoding'] || 'identity';
                
                let stream = res;
                if (encoding !== 'identity') {
                    if (encoding.includes('gzip')) {
                        stream = res.pipe(zlib.createGunzip());
                    } else if (encoding.includes('deflate')) {
                        stream = res.pipe(zlib.createInflate());
                    }
                }

                stream.on('data', (chunk) => {
                    chunks.push(chunk);
                    this.downloadedBytes += chunk.length;
                    
                    const now = Date.now();
                    if (now - this.lastUpdate > PROGRESS_UPDATE_INTERVAL) {
                        this.updateProgress();
                        this.lastUpdate = now;
                    }
                });

                stream.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    resolve({ buffer, index: chunkIndex, start });
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

    async download() {
        logger.info(`Starting advanced download: ${this.url}`);
        
        const downloadsDir = path.join(process.cwd(), 'downloads');
        const finalPath = path.join(downloadsDir, path.basename(this.filename));
        this.tempPath = finalPath + TEMP_EXTENSION;
        this.progressPath = finalPath + PROGRESS_EXTENSION;
        
        fs.mkdirSync(downloadsDir, { recursive: true });
        
        this.progressData = this.loadProgress();
        let resumeBytes = 0;
        
        if (this.progressData && fs.existsSync(this.tempPath)) {
            const tempStats = fs.statSync(this.tempPath);
            if (tempStats.size === this.progressData.downloadedBytes) {
                resumeBytes = this.progressData.downloadedBytes;
                this.totalBytes = this.progressData.totalBytes;
                logger.info(`Found valid partial download: ${this.formatBytes(resumeBytes)}`);
                logger.info(`Resuming download...`);
            } else {
                logger.warning("Progress file doesn't match temp file, starting fresh");
                this.cleanupProgress();
                if (fs.existsSync(this.tempPath)) fs.unlinkSync(this.tempPath);
            }
        }
        
        this.downloadedBytes = resumeBytes;
        
        logger.info(`Temporary file: ${this.tempPath}`);
        logger.info(`Final file will be: ${finalPath}`);

        let contentInfo;
        if (resumeBytes === 0) {
            const http2Info = await this.checkHTTP2Support();
            const useHTTP2 = http2Info.supportsHTTP2;
            
            if (useHTTP2) {
                contentInfo = http2Info;
                logger.info("Using HTTP/2 protocol");
            } else {
                contentInfo = await this.getContentInfoHTTP1();
                logger.info("Using HTTP/1.1 protocol");
            }

            this.totalBytes = contentInfo.length;
            logger.info(`File size: ${this.formatBytes(contentInfo.length)}`);
        } else {
            contentInfo = {
                length: this.totalBytes,
                acceptsRanges: true,
                supportsHTTP2: this.options.useHTTP2 && this.isHttps
            };
        }

        if (resumeBytes > 0) {
            if (resumeBytes >= contentInfo.length) {
                logger.info("File already complete, moving to final location");
                fs.renameSync(this.tempPath, finalPath);
                this.cleanupProgress();
                return {
                    filename: finalPath,
                    sha256: "resume-complete",
                    size: resumeBytes,
                    avgSpeed: 0,
                    duration: 0
                };
            }
            logger.info(`Resuming from: ${this.formatBytes(resumeBytes)}`);
        }

        if (!contentInfo.acceptsRanges) {
            logger.warning("Server doesn't support ranges - cannot resume, starting fresh");
            if (fs.existsSync(this.tempPath)) fs.unlinkSync(this.tempPath);
            this.cleanupProgress();
            this.downloadedBytes = 0;
            resumeBytes = 0;
        }

        this.saveProgress();

        if (!contentInfo.acceptsRanges || contentInfo.length < CHUNK_SIZE) {
            logger.info("Using single connection");
            return this.downloadSingle(contentInfo.supportsHTTP2, resumeBytes, finalPath);
        }

        logger.info(`Using ${this.options.connections} parallel connections`);

        const remainingBytes = contentInfo.length - resumeBytes;
        const chunkSize = Math.ceil(remainingBytes / this.options.connections);
        const promises = [];

        if (contentInfo.supportsHTTP2) {
            const session = await this.getHTTP2Session();
            for (let i = 0; i < this.options.connections; i++) {
                const start = resumeBytes + (i * chunkSize);
                const end = Math.min(start + chunkSize - 1, contentInfo.length - 1);
                if (start < contentInfo.length) {
                    promises.push(this.downloadChunkHTTP2(session, start, end, i));
                }
            }
        } else {
            for (let i = 0; i < this.options.connections; i++) {
                const start = resumeBytes + (i * chunkSize);
                const end = Math.min(start + chunkSize - 1, contentInfo.length - 1);
                if (start < contentInfo.length) {
                    promises.push(this.downloadChunkHTTP1(start, end, i));
                }
            }
        }

        const chunks = await Promise.all(promises);
        chunks.sort((a, b) => a.start - b.start);

        const writeStream = fs.createWriteStream(this.tempPath, {
            flags: resumeBytes > 0 ? 'a' : 'w',
            highWaterMark: this.options.bufferSize
        });

        for (const chunk of chunks) {
            this.hash.update(chunk.buffer);
            await new Promise((resolve, reject) => {
                writeStream.write(chunk.buffer, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }

        await new Promise((resolve) => writeStream.end(resolve));

        fs.renameSync(this.tempPath, finalPath);
        this.cleanupProgress();

        const sha256sum = this.hash.digest("hex");
        const elapsed = (Date.now() - this.startTime) / 1000;
        const avgSpeedBytesPerSec = this.downloadedBytes / elapsed;

        logger.success(`\nDownload completed: ${finalPath}`);
        logger.success(`SHA256: ${sha256sum}`);
        logger.success(`Average speed: ${this.formatSpeed(avgSpeedBytesPerSec)}`);
        logger.success(`Total time: ${elapsed.toFixed(1)}s`);

        return {
            filename: finalPath,
            sha256: sha256sum,
            size: this.downloadedBytes,
            avgSpeed: avgSpeedBytesPerSec,
            duration: elapsed
        };
    }

    async downloadSingle(useHTTP2, resumeBytes = 0, finalPath) {
        return useHTTP2 ? 
            this.downloadSingleHTTP2(resumeBytes, finalPath) : 
            this.downloadSingleHTTP1(resumeBytes, finalPath);
    }

    async downloadSingleHTTP2(resumeBytes = 0, finalPath) {
        const session = await this.getHTTP2Session();
        
        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET', resumeBytes > 0 ? `${resumeBytes}-` : null);
            headers[':method'] = 'GET';
            headers[':path'] = this.parsedUrl.pathname + this.parsedUrl.search;

            const req = session.request(headers);
            const writeStream = fs.createWriteStream(this.tempPath, {
                flags: resumeBytes > 0 ? 'a' : 'w',
                highWaterMark: this.options.bufferSize
            });

            let encoding = 'identity';
            let stream = req;

            req.on('response', (responseHeaders) => {
                const status = responseHeaders[':status'];
                if (status !== 200 && status !== 206) {
                    return reject(new Error(`HTTP ${status}`));
                }
                
                encoding = responseHeaders['content-encoding'] || 'identity';
                if (encoding !== 'identity') {
                    if (encoding.includes('gzip')) {
                        stream = req.pipe(zlib.createGunzip());
                    } else if (encoding.includes('deflate')) {
                        stream = req.pipe(zlib.createInflate());
                    } else if (encoding.includes('br')) {
                        stream = req.pipe(zlib.createBrotliDecompress());
                    }
                }

                stream.pipe(writeStream);
            });

            stream.on('data', (chunk) => {
                this.downloadedBytes += chunk.length;
                this.hash.update(chunk);
                
                const now = Date.now();
                if (now - this.lastUpdate > PROGRESS_UPDATE_INTERVAL) {
                    this.updateProgress();
                    this.lastUpdate = now;
                }
            });

            writeStream.on('finish', () => {
                fs.renameSync(this.tempPath, finalPath);
                this.cleanupProgress();
                
                const sha256sum = this.hash.digest("hex");
                const elapsed = (Date.now() - this.startTime) / 1000;
                const avgSpeedBytesPerSec = this.downloadedBytes / elapsed;

                logger.success(`\nHTTP/2 download completed: ${finalPath}`);
                logger.success(`SHA256: ${sha256sum}`);
                logger.success(`Average speed: ${this.formatSpeed(avgSpeedBytesPerSec)}`);

                resolve({
                    filename: finalPath,
                    sha256: sha256sum,
                    size: this.downloadedBytes,
                    avgSpeed: avgSpeedBytesPerSec,
                    duration: elapsed
                });
            });

            req.on('error', reject);
            writeStream.on('error', reject);
        });
    }

    async downloadSingleHTTP1(resumeBytes = 0, finalPath) {
        const requestModule = this.isHttps ? https : http;
        const agent = createHTTP1Agent(this.isHttps);

        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET', resumeBytes > 0 ? `${resumeBytes}-` : null);
            delete headers[':method'];
            delete headers[':path'];

            const req = requestModule.get(this.url, { agent, headers }, (res) => {
                if (res.statusCode !== 200 && res.statusCode !== 206) {
                    return reject(new Error(`HTTP ${res.statusCode}`));
                }

                const writeStream = fs.createWriteStream(this.tempPath, {
                    flags: resumeBytes > 0 ? 'a' : 'w',
                    highWaterMark: this.options.bufferSize
                });

                const encoding = res.headers['content-encoding'] || 'identity';
                let stream = res;

                if (encoding !== 'identity') {
                    if (encoding.includes('gzip')) {
                        stream = res.pipe(zlib.createGunzip());
                    } else if (encoding.includes('deflate')) {
                        stream = res.pipe(zlib.createInflate());
                    }
                }

                stream.pipe(writeStream);

                stream.on('data', (chunk) => {
                    this.downloadedBytes += chunk.length;
                    this.hash.update(chunk);
                    
                    const now = Date.now();
                    if (now - this.lastUpdate > PROGRESS_UPDATE_INTERVAL) {
                        this.updateProgress();
                        this.lastUpdate = now;
                    }
                });

                writeStream.on('finish', () => {
                    fs.renameSync(this.tempPath, finalPath);
                    this.cleanupProgress();
                    
                    const sha256sum = this.hash.digest("hex");
                    const elapsed = (Date.now() - this.startTime) / 1000;
                    const avgSpeedBytesPerSec = this.downloadedBytes / elapsed;

                    logger.success(`\nDownload completed: ${finalPath}`);
                    logger.success(`SHA256: ${sha256sum}`);
                    logger.success(`Average speed: ${this.formatSpeed(avgSpeedBytesPerSec)}`);

                    resolve({
                        filename: finalPath,
                        sha256: sha256sum,
                        size: this.downloadedBytes,
                        avgSpeed: avgSpeedBytesPerSec,
                        duration: elapsed
                    });
                });

                res.on('error', reject);
                writeStream.on('error', reject);
            });

            req.on('error', reject);
        });
    }
}

async function downloadISO(url, filename, options = {}) {
    const downloader = new Downloader(url, filename, options);
    return downloader.download();
}

process.on('exit', () => {
    for (const agent of agentCache.values()) {
        agent.destroy();
    }
    for (const session of http2SessionCache.values()) {
        if (!session.destroyed) {
            session.destroy();
        }
    }
});


process.on('SIGINT', () => {
    console.log('\nDownload interrupted. Progress has been saved and can be resumed.');
    process.exit(0);
});

module.exports = { downloadISO };