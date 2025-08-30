const http2 = require("http2");

const http2SessionCache = new Map();
const TCP_WINDOW_SIZE = 1048576;

class HTTP2Downloader {
    constructor(url, parsedUrl, options = {}) {
        this.url = url;
        this.parsedUrl = parsedUrl;
        this.options = options;
        this.authority = `${parsedUrl.hostname}:${parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80)}`;
    }

    async getHTTP2Session() {
        let session = http2SessionCache.get(this.authority);
        if (session && !session.destroyed) return session;
        if (session) http2SessionCache.delete(this.authority);
        
        session = http2.connect(this.parsedUrl.protocol + '//' + this.authority, {
            settings: {
                headerTableSize: 65536,
                enablePush: false,
                initialWindowSize: TCP_WINDOW_SIZE,
                maxFrameSize: 16384
            }
        });
        
        session.setMaxListeners(100);
        http2SessionCache.set(this.authority, session);
        
        return new Promise((resolve, reject) => {
            session.on('connect', () => resolve(session));
            session.on('error', reject);
            session.setTimeout(30000, () => { 
                session.destroy(); 
                reject(new Error('HTTP/2 connection timeout')); 
            });
        });
    }

    createRequestHeaders(method, range = null) {
        const headers = {
            ':method': method,
            ':path': this.parsedUrl.pathname + this.parsedUrl.search,
            ':authority': this.authority,
            ':scheme': this.parsedUrl.protocol.slice(0, -1),
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'accept': '*/*',
            'accept-encoding': this.options.useCompression ? 'gzip, deflate, br' : 'identity',
            'cache-control': 'no-cache'
        };

        if (range) {
            headers['range'] = `bytes=${range}`;
        }

        return headers;
    }

    async checkHTTP2Support() {
        try {
            const session = await this.getHTTP2Session();
            return new Promise((resolve) => {
                const headers = this.createRequestHeaders('HEAD');
                const req = session.request(headers);
                
                req.on('response', (headers) => {
                    const statusCode = headers[':status'];
                    const length = parseInt(headers['content-length'] || '0', 10);
                    const acceptsRanges = headers['accept-ranges'] === 'bytes';
                    req.destroy();
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

    async downloadChunk(session, start, end, chunkIndex, onProgress, writeCallback) {
        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET', `${start}-${end}`);
            const req = session.request(headers);
            
            req.on('response', (responseHeaders) => {
                const status = responseHeaders[':status'];
                if (status !== 206 && status !== 200) {
                    req.destroy();
                    return reject(new Error(`HTTP ${status} for chunk ${chunkIndex}`));
                }
            });
            
            req.on('data', async (chunk) => {
                try {
                    await writeCallback(chunk);
                    onProgress(chunk.length);
                } catch (error) {
                    req.destroy();
                    reject(error);
                }
            });
            
            req.on('end', () => {
                resolve({ buffer: Buffer.alloc(0), index: chunkIndex, start });
            });
            
            req.on('error', reject);
            req.setTimeout(30000, () => { 
                req.destroy(); 
                reject(new Error(`HTTP/2 chunk ${chunkIndex} timeout`)); 
            });
        });
    }

    async downloadSingleStreaming(session, onProgress, writeCallback) {
        return new Promise((resolve, reject) => {
            const headers = this.createRequestHeaders('GET');
            
            const req = session.request(headers);
            
            req.on('response', (responseHeaders) => {
                const status = responseHeaders[':status'];
                if (status < 200 || status >= 300) {
                    req.destroy();
                    return reject(new Error(`HTTP ${status}`));
                }
            });
            
            req.on('data', async (chunk) => {
                try {
                    await writeCallback(chunk);
                    onProgress(chunk.length);
                } catch (error) {
                    req.destroy();
                    reject(error);
                }
            });
            
            req.on('end', () => {
                resolve();
            });
            
            req.on('error', reject);
            req.setTimeout(30000, () => { 
                req.destroy(); 
                reject(new Error('HTTP/2 streaming download timeout')); 
            });
        });
    }
}

module.exports = { HTTP2Downloader };