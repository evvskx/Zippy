const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const { terminal } = require("terminal-kit");
const logger = require("./logger");

const CHUNK_SIZE = 2 * 1024 * 1024; 
const MAX_CONNECTIONS = 4;
const PROGRESS_UPDATE_INTERVAL = 100;

class MultiDownloader {
    constructor(url, filename) {
        this.url = url;
        this.filename = filename + ".iso";
        this.totalBytes = 0;
        this.downloadedBytes = 0;
        this.startTime = Date.now();
        this.lastUpdate = 0;
        this.lastProgressLength = 0;
        this.parsedUrl = new URL(this.url);
        this.isHttps = this.parsedUrl.protocol === 'https:';
        this.fileFd = null;
        this.finalPath = null;
        this.interrupted = false;
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
                    resolve({ length, acceptsRanges });
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
        const speed = this.downloadedBytes / elapsed;
        const percent = this.downloadedBytes / this.totalBytes;
        const eta = (this.totalBytes - this.downloadedBytes) / (speed || 1);
        const barLength = 30;
        const filled = Math.min(barLength, Math.floor(percent * barLength));
        const bar = "=".repeat(filled) + " ".repeat(barLength - filled);
        const progressText = `[${bar}] ${this.formatBytes(this.downloadedBytes)} / ${this.formatBytes(this.totalBytes)} | ${this.formatSpeed(speed)} | ETA: ${this.formatETA(eta)}`;
        process.stdout.write('\r' + progressText + ' '.repeat(Math.max(0, (this.lastProgressLength || 0) - progressText.length)));
        this.lastProgressLength = progressText.length;
    }

    onProgressUpdate(bytes) {
        this.downloadedBytes += bytes;
        const now = Date.now();
        if (now - this.lastUpdate > PROGRESS_UPDATE_INTERVAL) {
            this.updateProgress();
            this.lastUpdate = now;
        }
    }

    downloadChunk(start, end) {
        return new Promise((resolve, reject) => {
            const options = {
                headers: { 
                    Range: `bytes=${start}-${end}`,
                    'Cache-Control': 'no-cache'
                },
            };
            const req = this.getRequestModule().get(this.url, options, res => {
                if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`));
                res.on('data', chunk => {
                    fs.write(this.fileFd, chunk, 0, chunk.length, start, err => {
                        if (err) reject(err);
                        this.onProgressUpdate(chunk.length);
                        start += chunk.length;
                    });
                });
                res.on('end', resolve);
            });
            req.on('error', reject);
        });
    }

    async download() {
        logger.info("Starting download: " + this.url);
        const downloadsDir = path.join(process.cwd(), 'downloads');
        this.finalPath = path.join(downloadsDir, path.basename(this.filename));
        fs.mkdirSync(downloadsDir, { recursive: true });
        this.fileFd = fs.openSync(this.finalPath, 'w');

        const { length, acceptsRanges } = await this.getHeaders();
        this.totalBytes = length;

        if (!acceptsRanges) {
            logger.info("Server doesn't support ranges, falling back to single connection.");
            await this.downloadChunk(0, this.totalBytes - 1);
        } else {
            const chunks = [];
            for (let i = 0; i < this.totalBytes; i += CHUNK_SIZE) {
                chunks.push([i, Math.min(i + CHUNK_SIZE - 1, this.totalBytes - 1)]);
            }
            const active = [];
            while (chunks.length) {
                while (active.length < MAX_CONNECTIONS && chunks.length) {
                    const [start, end] = chunks.shift();
                    const p = this.downloadChunk(start, end).finally(() => {
                        active.splice(active.indexOf(p), 1);
                    });
                    active.push(p);
                }
                await Promise.race(active);
            }
            await Promise.all(active);
        }

        fs.closeSync(this.fileFd);
        if (!this.interrupted) {
            const elapsed = (Date.now() - this.startTime) / 1000;
            console.log("");
            logger.success(`Download completed: ${this.finalPath}`);
            logger.success(`Average speed: ${this.formatSpeed(this.downloadedBytes / elapsed)}`);
            logger.success(`Total time: ${elapsed.toFixed(1)}s`);
        }
    }

    cleanup() {
        if (this.interrupted && this.finalPath && fs.existsSync(this.finalPath)) {
            fs.unlinkSync(this.finalPath);
            logger.info("Download interrupted. Partial file deleted.");
        }
    }
}

async function downloadISO(url, filename) {
    const downloader = new MultiDownloader(url, filename);
    return downloader.download();
}

module.exports = { downloadISO };
