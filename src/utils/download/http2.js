const http2 = require("http2");
const { URL } = require("url");

const http2SessionCache = new Map();
const TCP_WINDOW_SIZE = 1048576;

class HTTP2Downloader {
    constructor(url, parsedUrl, options = {}) {
        this.url = url;
        this.parsedUrl = parsedUrl;
        this.options = options;
        this.authority = `${parsedUrl.hostname}:${parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80)}`;
    }

    async getHTTP2Session(authority = null) {
        const sessionAuthority = authority || this.authority;
        let session = http2SessionCache.get(sessionAuthority);
        if (session && !session.destroyed) return session;
        if (session) http2SessionCache.delete(sessionAuthority);
        
        const protocol = sessionAuthority.includes(':443') ? 'https:' : 'http:';
        session = http2.connect(protocol + '//' + sessionAuthority, {
            settings: {
                headerTableSize: 65536,
                enablePush: false,
                initialWindowSize: TCP_WINDOW_SIZE,
                maxFrameSize: 16384
            }
        });
        
        session.setMaxListeners(100);
        http2SessionCache.set(sessionAuthority, session);
        
        return new Promise((resolve, reject) => {
            session.on('connect', () => resolve(session));
            session.on('error', reject);
            session.setTimeout(30000, () => { 
                session.destroy(); 
                reject(new Error('HTTP/2 connection timeout')); 
            });
        });
    }

    createRequestHeaders(method, parsedUrl, range = null) {
        const headers = {
            ':method': method,
            ':path': parsedUrl.pathname + parsedUrl.search,
            ':authority': `${parsedUrl.hostname}:${parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80)}`,
            ':scheme': parsedUrl.protocol.slice(0, -1),
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

    async followRedirects(url, method = 'HEAD', range = null, maxRedirects = 5) {
        let currentUrl = url;
        let redirectCount = 0;

        while (redirectCount < maxRedirects) {
            const parsedUrl = new URL(currentUrl);
            const authority = `${parsedUrl.hostname}:${parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80)}`;

            try {
                const session = await this.getHTTP2Session(authority);
                const headers = this.createRequestHeaders(method, parsedUrl, range);

                const result = await new Promise((resolve, reject) => {
                    const req = session.request(headers);
                    
                    req.on('response', (responseHeaders) => {
                        const status = responseHeaders[':status'];
                        if (status >= 300 && status < 400 && responseHeaders.location) {
                            const location = responseHeaders.location;
                            const redirectUrl = location.startsWith('http') ? location : new URL(location, currentUrl).href;
                            req.destroy();
                            resolve({ redirect: true, url: redirectUrl, headers: responseHeaders });
                        } else {
                            resolve({ redirect: false, headers: responseHeaders, req });
                        }
                    });

                    req.on('error', reject);
                    req.setTimeout(10000, () => { 
                        req.destroy(); 
                        reject(new Error(`${method} request timeout`)); 
                    });
                    
                    if (method === 'HEAD') {
                        req.end();
                    }
                });

                if (result.redirect) {
                    currentUrl = result.url;
                    redirectCount++;
                    continue;
                }

                return { finalUrl: currentUrl, headers: result.headers, req: result.req, session, parsedUrl };
            } catch (error) {
                throw error;
            }
        }

        throw new Error(`Too many redirects (${maxRedirects})`);
    }

    async checkHTTP2Support() {
        try {
            const { headers } = await this.followRedirects(this.url, 'HEAD');
            const statusCode = headers[':status'];
            const length = parseInt(headers['content-length'] || '0', 10);
            const acceptsRanges = headers['accept-ranges'] === 'bytes';
            
            return { 
                supportsHTTP2: statusCode >= 200 && statusCode < 300,
                length, 
                acceptsRanges,
                headers 
            };
        } catch {
            return { supportsHTTP2: false };
        }
    }

    async downloadChunk(session, start, end, chunkIndex, onProgress, writeCallback) {
        try {
            const { req, headers } = await this.followRedirects(this.url, 'GET', `${start}-${end}`);
            
            return new Promise((resolve, reject) => {
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
                
                req.end();
            });
        } catch (error) {
            throw error;
        }
    }

    async downloadSingleStreaming(session, onProgress, writeCallback) {
        try {
            const { req } = await this.followRedirects(this.url, 'GET');
            
            return new Promise((resolve, reject) => {
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
                
                req.end();
            });
        } catch (error) {
            throw error;
        }
    }
}

module.exports = { HTTP2Downloader };