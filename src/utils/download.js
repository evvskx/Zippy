const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const logger = require("./logger");

const CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_CONNECTIONS = 5;

class WriteQueue {
    constructor(fd) {
        this.fd = fd;
        this.queue = [];
        this.processing = false;
    }
    enqueue(buffer, position) {
        return new Promise((resolve, reject) => {
            this.queue.push({ buffer, position, resolve, reject });
            this.process();
        });
    }
    process() {
        if (this.processing || this.queue.length === 0) return;
        this.processing = true;
        const { buffer, position, resolve, reject } = this.queue.shift();
        fs.write(this.fd, buffer, 0, buffer.length, position, (err) => {
            this.processing = false;
            if (err) reject(err);
            else resolve();
            this.process();
        });
    }
}

class Downloader {
    constructor(url, filename) {
        this.url = url;
        this.filename = filename + ".iso";
        this.totalBytes = 0;
        this.downloadedBytes = 0;
        this.startTime = Date.now();
        this.lastProgressLength = 0;
        this.parsedUrl = new URL(this.url);
        this.isHttps = this.parsedUrl.protocol === 'https:';
        this.fileFd = null;
        this.finalPath = null;
        this.interrupted = false;
        this.completed = false;
        this.chunkStatus = new Map();
        this.progressInterval = null;
        process.on('exit', () => this.cleanup());
        process.on('SIGINT', () => {
            this.interrupted = true;
            process.exit();
        });
    }

    getRequestModule() {
        return this.isHttps ? https : http;
    }

    async getHeaders() {
        return new Promise((resolve, reject) => {
            const urlObj = this.parsedUrl;
            const req = this.getRequestModule().request(
                { method: 'HEAD', host: urlObj.hostname, path: urlObj.pathname + urlObj.search, port: urlObj.port || undefined },
                res => {
                    const length = parseInt(res.headers['content-length'] || '0', 10);
                    const acceptsRanges = res.headers['accept-ranges'] === 'bytes';
                    const disposition = res.headers['content-disposition'];
                    let filename = this.filename;
                    if (disposition) {
                        const match = disposition.match(/filename[^;=\n]*=(?:UTF-8'')?["']?([^;"']+)["']?/i);
                        if (match && match[1]) filename = decodeURIComponent(match[1]);
                    } else {
                        const pathName = urlObj.pathname;
                        if (pathName && pathName !== '/') {
                            filename = path.basename(pathName) || this.filename;
                        }
                    }
                    resolve({ length, acceptsRanges, filename });
                }
            );
            req.on('error', reject);
            req.end();
        });
    }

    formatBytes(bytes) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let i = 0;
        let num = bytes;
        while (num >= 1024 && i < units.length - 1) {
            num /= 1024;
            i++;
        }
        return num.toFixed(1) + ' ' + units[i];
    }

    formatSpeed(bytesPerSecond) {
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        let i = 0;
        let num = bytesPerSecond;
        while (num >= 1024 && i < units.length - 1) {
            num /= 1024;
            i++;
        }
        return num.toFixed(1) + ' ' + units[i];
    }

    formatETA(seconds) {
        if (!isFinite(seconds) || seconds < 0) return "∞";
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const parts = [];
        if (d > 0) parts.push(`${d}d`);
        if (h > 0) parts.push(`${h}h`);
        if (m > 0) parts.push(`${m}m`);
        if (s > 0 || parts.length === 0) parts.push(`${s}s`);
        return parts.join(' ');
    }

    updateProgress() {
        const now = Date.now();
        const elapsed = (now - this.startTime) / 1000;
        if (elapsed <= 0 || this.totalBytes <= 0) return;
        const speed = this.downloadedBytes / elapsed;
        const percent = Math.min(1, this.downloadedBytes / this.totalBytes);
        const remaining = Math.max(0, this.totalBytes - this.downloadedBytes);
        const eta = speed > 0 ? remaining / speed : Infinity;
        const barLength = 30;
        const filled = Math.min(barLength, Math.floor(percent * barLength));
        const bar = "=".repeat(filled) + " ".repeat(barLength - filled);
        const percentText = (percent * 100).toFixed(1) + '% |';
        const progressText = `[${bar}] ${percentText} ${this.formatBytes(this.downloadedBytes)} / ${this.formatBytes(this.totalBytes)} | ${this.formatSpeed(speed)} | ETA: ${this.formatETA(eta)}`;
        process.stdout.write('\r' + progressText + ' '.repeat(Math.max(0, (this.lastProgressLength || 0) - progressText.length)));
        this.lastProgressLength = progressText.length;
    }

    onProgressUpdate(bytes) {
        this.downloadedBytes += bytes;
        if (this.downloadedBytes > this.totalBytes) this.downloadedBytes = this.totalBytes;
    }

    async downloadChunk(start, end, retries = 3) {
        const chunkId = `${start}-${end}`;
        if (this.chunkStatus.has(chunkId)) return;
        const options = { headers: { Range: `bytes=${start}-${end}`, 'Cache-Control': 'no-cache', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' } };
        return new Promise((resolve, reject) => {
            const req = this.getRequestModule().get(this.url, options, res => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} for chunk ${chunkId}`));
                let receivedBytes = 0;
                let chunks = [];
                res.on('data', chunk => { chunks.push(chunk); receivedBytes += chunk.length; });
                res.on('end', async () => {
                    const expectedBytes = end - start + 1;
                    const tolerance = Math.min(1024, expectedBytes * 0.01);
                    if (receivedBytes >= expectedBytes - tolerance) {
                        try {
                            const buffer = Buffer.concat(chunks);
                            await this.writeQueue.enqueue(buffer, start);
                            this.onProgressUpdate(buffer.length);
                            this.chunkStatus.set(chunkId, true);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    } else if (retries > 0) {
                        setTimeout(() => resolve(this.downloadChunk(start, end, retries - 1)), 1000);
                    } else {
                        try {
                            const buffer = Buffer.concat(chunks);
                            await this.writeQueue.enqueue(buffer, start);
                            this.onProgressUpdate(buffer.length);
                            this.chunkStatus.set(chunkId, true);
                            resolve();
                        } catch (err) {
                            reject(err);
                        }
                    }
                });
                res.on('error', err => {
                    if (retries > 0) setTimeout(() => resolve(this.downloadChunk(start, end, retries - 1)), 1000);
                    else reject(err);
                });
            });
            req.on('error', err => {
                if (retries > 0) setTimeout(() => resolve(this.downloadChunk(start, end, retries - 1)), 1000);
                else reject(err);
            });
            req.setTimeout(30000, () => {
                req.destroy();
                if (retries > 0) setTimeout(() => resolve(this.downloadChunk(start, end, retries - 1)), 1000);
                else reject(new Error(`Timeout for chunk ${chunkId}`));
            });
        });
    }

    startProgressInterval() {
        this.progressInterval = setInterval(() => {
            this.updateProgress();
        }, 1000);
    }

    stopProgressInterval() {
        if (this.progressInterval) {
            clearInterval(this.progressInterval);
            this.progressInterval = null;
        }
    }

    async download() {
        try {
            const downloadsDir = path.join(process.cwd(), 'downloads');
            fs.mkdirSync(downloadsDir, { recursive: true });
            const { length, acceptsRanges, filename } = await this.getHeaders();
            this.totalBytes = length;
            this.filename = filename;
            this.finalPath = path.join(downloadsDir, this.filename);
            if (fs.existsSync(this.finalPath)) {
                const stats = fs.statSync(this.finalPath);
                if (Math.abs(stats.size - this.totalBytes) < 1024) {
                    logger.success("File already exists and is complete!");
                    return;
                } else {
                    logger.warn("Existing file is incomplete, redownloading...");
                    fs.unlinkSync(this.finalPath);
                }
            }
            this.fileFd = fs.openSync(this.finalPath, 'w');
            this.writeQueue = new WriteQueue(this.fileFd);
            this.startProgressInterval();
            if (!acceptsRanges || this.totalBytes < CHUNK_SIZE) {
                await this.downloadChunk(0, this.totalBytes - 1);
            } else {
                const chunks = [];
                for (let i = 0; i < this.totalBytes; i += CHUNK_SIZE) chunks.push([i, Math.min(i + CHUNK_SIZE - 1, this.totalBytes - 1)]);
                const active = [];
                let chunkIndex = 0;
                while (chunkIndex < chunks.length && !this.interrupted) {
                    while (active.length < MAX_CONNECTIONS && chunkIndex < chunks.length) {
                        const [start, end] = chunks[chunkIndex++];
                        const p = this.downloadChunk(start, end).finally(() => { const index = active.indexOf(p); if (index > -1) active.splice(index, 1); });
                        active.push(p);
                    }
                    if (active.length > 0) await Promise.race(active);
                }
                await Promise.all(active);
            }
            fs.closeSync(this.fileFd);
            this.stopProgressInterval();
            this.downloadedBytes = this.totalBytes;
            this.updateProgress();
            console.log("");
            if (!this.interrupted) {
                const stats = fs.statSync(this.finalPath);
                const sizeDiff = Math.abs(stats.size - this.totalBytes);
                if (sizeDiff > 1024) logger.warn(`File size difference: ${sizeDiff} bytes (expected: ${this.totalBytes}, got: ${stats.size})`);
                this.completed = true;
                const elapsed = (Date.now() - this.startTime) / 1000;
                logger.success(`Download completed: ${this.finalPath}`);
                logger.success(`Average speed: ${this.formatSpeed(this.downloadedBytes / elapsed)}`);
                logger.success(`Total time: ${elapsed.toFixed(1)}s`);
            }
        } catch (error) {
            this.stopProgressInterval();
            if (this.fileFd) fs.closeSync(this.fileFd);
            logger.error("Download failed:", error.message);
            this.cleanup();
            throw error;
        }
    }

    cleanup() {
        if (this.interrupted && !this.completed && this.finalPath && fs.existsSync(this.finalPath)) {
            fs.unlinkSync(this.finalPath);
            logger.info("Download interrupted. Partial file deleted.");
        }
    }
}

async function downloadISO(url, filename) {
    const downloader = new Downloader(url, filename);
    return downloader.download();
}

module.exports = { downloadISO };
