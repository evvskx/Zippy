const fs = require("fs");
const logger = require("./logger");
const path = require("path");
const { URL } = require("url");
const { HTTP1Downloader } = require("./download/http1");
const { HTTP2Downloader } = require("./download/http2");
const { terminal } = require("terminal-kit");

const CHUNK_SIZE = 256 * 1024;
const PARALLEL_CONNECTIONS = 8;
const BUFFER_SIZE = 64 * 1024 * 1024;
const PROGRESS_UPDATE_INTERVAL = 100;

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
        this.lastUpdate = 0;
        this.lastProgressLength = 0;
        this.parsedUrl = new URL(this.url);
        this.isHttps = this.parsedUrl.protocol === 'https:';
        this.fileFd = null;

        this.http1Downloader = new HTTP1Downloader(this.url, this.isHttps, this.options);
        this.http2Downloader = new HTTP2Downloader(this.url, this.parsedUrl, this.options);
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

    updateProgress() {
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
    }

    async writeChunkImmediately(buffer) {
        return new Promise((resolve, reject) => {
            if (this.fileFd === null) {
                reject(new Error('File descriptor is null'));
                return;
            }
            
            fs.write(this.fileFd, buffer, 0, buffer.length, null, (err, bytesWritten) => {
                if (err) {
                    reject(err);
                } else {
                    if (this.fileFd !== null) {
                        fs.fsync(this.fileFd, (syncErr) => {
                            if (syncErr) {
                                reject(syncErr);
                            } else {
                                resolve(bytesWritten);
                            }
                        });
                    } else {
                        resolve(bytesWritten);
                    }
                }
            });
        });
    }

    onProgressUpdate(bytesAdded) {
        this.downloadedBytes += bytesAdded;
        const now = Date.now();
        if (now - this.lastUpdate > PROGRESS_UPDATE_INTERVAL) {
            this.updateProgress();
            this.lastUpdate = now;
        }
    }

    async download() {
        terminal.clear();

        logger.info(`Starting download: ${this.url}`);
        
        const downloadsDir = path.join(process.cwd(), 'downloads');
        const finalPath = path.join(downloadsDir, path.basename(this.filename));
        
        fs.mkdirSync(downloadsDir, { recursive: true });
        
        logger.info(`Download file: ${finalPath}`);

        let contentInfo;
        let useHTTP2 = false;
        
        if (this.options.useHTTP2 && this.isHttps) {
            const http2Info = await this.http2Downloader.checkHTTP2Support();
            if (http2Info.supportsHTTP2) {
                contentInfo = http2Info;
                useHTTP2 = true;
            } else {
                contentInfo = await this.http1Downloader.getContentInfo();
            }
        } else {
            contentInfo = await this.http1Downloader.getContentInfo();
        }
        
        this.totalBytes = contentInfo.length;
        logger.info(`File size: ${this.formatBytes(contentInfo.length)}`);

        this.fileFd = fs.openSync(finalPath, 'w');

        try {
            if (!contentInfo.acceptsRanges || contentInfo.length < CHUNK_SIZE) {
                return await this.downloadSingle(useHTTP2, finalPath);
            }
            return await this.downloadParallel(useHTTP2, contentInfo.length, finalPath);
        } finally {
            if (this.fileFd !== null) {
                try {
                    fs.closeSync(this.fileFd);
                } catch (error) {}
            }
        }
    }

    async downloadSingle(useHTTP2, finalPath) {
        try {
            const writeCallback = async (buffer) => {
                await this.writeChunkImmediately(buffer);
            };

            if (useHTTP2) {
                const session = await this.http2Downloader.getHTTP2Session();
                await this.http2Downloader.downloadSingleStreaming(
                    session, 
                    (bytes) => this.onProgressUpdate(bytes),
                    writeCallback
                );
            } else {
                await this.http1Downloader.downloadSingleStreaming(
                    (bytes) => this.onProgressUpdate(bytes),
                    writeCallback
                );
            }

            fs.closeSync(this.fileFd);
            this.fileFd = null;

            const elapsed = (Date.now() - this.startTime) / 1000;
            const avgSpeedBytesPerSec = this.downloadedBytes / elapsed;

            logger.success(`\nDownload completed: ${finalPath}`);
            logger.success(`Average speed: ${this.formatSpeed(avgSpeedBytesPerSec)}`);
            logger.success(`Total time: ${elapsed.toFixed(1)}s`);

            return { 
                filename: finalPath,
                size: this.downloadedBytes, 
                avgSpeed: avgSpeedBytesPerSec, 
                duration: elapsed 
            };
        } catch (error) {
            if (this.fileFd !== null) {
                try { fs.closeSync(this.fileFd); } catch {}
                this.fileFd = null;
            }
            throw error;
        }
    }

    async downloadParallel(useHTTP2, totalLength, finalPath) {
        const chunkSize = Math.ceil(totalLength / this.options.connections);

        const writeCallback = async (buffer) => {
            await this.writeChunkImmediately(buffer);
        };

        const chunks = [];

        if (useHTTP2) {
            const session = await this.http2Downloader.getHTTP2Session();
            for (let i = 0; i < this.options.connections; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize - 1, totalLength - 1);
                if (start < totalLength) {
                    chunks.push(this.downloadChunkAndWrite(
                        () => this.http2Downloader.downloadChunk(
                            session, 
                            start, 
                            end, 
                            i, 
                            (bytes) => this.onProgressUpdate(bytes),
                            writeCallback
                        )
                    ));
                }
            }
        } else {
            for (let i = 0; i < this.options.connections; i++) {
                const start = i * chunkSize;
                const end = Math.min(start + chunkSize - 1, totalLength - 1);
                if (start < totalLength) {
                    chunks.push(this.downloadChunkAndWrite(
                        () => this.http1Downloader.downloadChunk(
                            start, 
                            end, 
                            i, 
                            (bytes) => this.onProgressUpdate(bytes),
                            writeCallback
                        )
                    ));
                }
            }
        }

        await Promise.all(chunks);

        fs.closeSync(this.fileFd);
        this.fileFd = null;

        const elapsed = (Date.now() - this.startTime) / 1000;
        const avgSpeedBytesPerSec = this.downloadedBytes / elapsed;

        logger.success(`\nDownload completed: ${finalPath}`);
        logger.success(`Average speed: ${this.formatSpeed(avgSpeedBytesPerSec)}`);
        logger.success(`Total time: ${elapsed.toFixed(1)}s`);

        return { 
            filename: finalPath, 
            size: this.downloadedBytes, 
            avgSpeed: avgSpeedBytesPerSec, 
            duration: elapsed 
        };
    }

    async downloadChunkAndWrite(downloadFn) {
        const chunk = await downloadFn();
        return chunk;
    }
}

async function downloadISO(url, filename, options = {}) {
    const downloader = new Downloader(url, filename, options);
    return downloader.download();
}

module.exports = { downloadISO };