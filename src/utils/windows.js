const axios = require("axios");
const { v4: uuidv4 } = require('uuid');
const term = require("terminal-kit").terminal;
const logger = require("./logger");
const net = require('net');
const fs = require('fs');
const { getValidProxy } = require("./proxy");

let currentProxy = null;
let proxyAttempted = false;

async function axiosWithProxy(url, options = {}) {
    if (!proxyAttempted && !currentProxy) {
        currentProxy = await getValidProxy(5000);
        proxyAttempted = true;
    }

    if (currentProxy) {
        try {
            const [host, port] = currentProxy.split(":");
            const instance = axios.create({
                ...options,
                proxy: { host, port: parseInt(port) },
                timeout: options.timeout || 60000
            });
            return await instance.get(url);
        } catch (err) {
            currentProxy = null;
        }
    }

    try {
        return await axios.get(url, { ...options, timeout: options.timeout || 60000 });
    } catch (err) {
        return null;
    }
}


class WindowsDownloader {
    constructor(architecture, locale = "en-US") {
        this.architecture = architecture;
        this.locale = locale;
        this.baseUrl = "https://www.microsoft.com/" + locale + "/software-download/";
        this.orgId = "y6jn8c31";
        this.profileId = "606624d44113";
        
        this.headers = {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 14; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': this.locale,
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0'
        };

        this.sessionIds = [null, null];
        this.translations = this.loadTranslations();

        this.windowsVersions = [
            {
                name: "Windows 11",
                id: "windows11",
                releases: [
                    {
                        name: "24H2 (Build 26100.1742 - 2024.10)",
                        editions: [
                            { name: "Windows 11 Home/Pro/Edu", ids: [3113, 3131] }
                        ]
                    }
                ]
            },
            {
                name: "Windows 10", 
                id: "Windows10ISO",
                releases: [
                    {
                        name: "22H2 v1 (Build 19045.2965 - 2023.05)",
                        editions: [
                            { name: "Windows 10 Home/Pro/Edu", ids: [2618] }
                        ]
                    }
                ]
            }
        ];
    }
    

    loadTranslations() {
        const translations = {
            'en-US': {
                'Version': 'Version',
                'Release': 'Release',
                'Edition': 'Edition',
                'Language': 'Language',
                'Architecture': 'Architecture',
                'Download': 'Download',
                'Continue': 'Continue',
                'Back': 'Back',
                'Close': 'Close',
                'Cancel': 'Cancel',
                'Error': 'Error',
                'Please wait...': 'Please wait...'
            }
        };
        return translations[this.locale] || translations['en-US'];
    }

    t(key) {
        return this.translations[key] || key;
    }

    padRight(str, width) {
        const len = [...str].length;
        return str + ' '.repeat(Math.max(0, width - len));
    }

    calculateItemsPerPage() {
        const MIN_ITEMS = 5;
        if (term.width >= 120 && term.height >= 40) return 35;
        if (term.width >= 80 && term.height >= 30) return 20;
        return MIN_ITEMS;
    }

    async displayPaginatedMenu(choices, title) {
        if (!choices || choices.length === 0) return null;
        if (choices.length === 1) return choices[0];

        const ITEMS_PER_PAGE = this.calculateItemsPerPage();
        const totalPages = Math.ceil(choices.length / ITEMS_PER_PAGE);
        let currentPage = 0;
        let selectedIdx = 0;

        const renderPage = () => {
            term.moveTo(1, 1);
            term.eraseDisplayBelow();
            term.bold.brightCyan(`\n╔════════════════════════════════════════════════════════════════════════╗\n`);
            term.bold.brightCyan(`║`).bold.white(this.padRight(` ${title}`, 72)).bold.brightCyan(`║\n`);
            term.bold.brightCyan(`╚════════════════════════════════════════════════════════════════════════╝\n\n`);
            
            const startIdx = currentPage * ITEMS_PER_PAGE;
            const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, choices.length);
            const pageChoices = choices.slice(startIdx, endIdx);
            
            const cols = Math.min(5, Math.floor(term.width / 30));
            const rows = Math.ceil(pageChoices.length / cols);
            
            for (let row = 0; row < rows; row++) {
                let rowText = '';
                for (let col = 0; col < cols; col++) {
                    const idx = col * rows + row;
                    if (idx < pageChoices.length) {
                        const globalIdx = startIdx + idx;
                        const choice = typeof pageChoices[idx] === 'object' ? pageChoices[idx].name : pageChoices[idx];
                        const display = globalIdx === selectedIdx ? `> ${choice}` : `  ${choice}`;
                        rowText += this.padRight(display, 30);
                    }
                }
                term(rowText + '\n');
            }
            
            term.bold.brightYellow(`\n┌────────────────────────────────────────────────────────────────────────┐\n`);
            term.bold.brightYellow(`│`).white(this.padRight(` Page ${currentPage + 1} of ${totalPages} | Items ${startIdx + 1}-${endIdx} of ${choices.length}`, 72)).bold.brightYellow(`│\n`);
            term.bold.brightYellow(`└────────────────────────────────────────────────────────────────────────┘\n\n`);
            
            term.brightBlue("←").white(" | ");
            term.brightBlue("→").white(" | ");
            term.brightBlue("↑").white(" | ");
            term.brightBlue("↓").white(" | ");
            term.brightGreen("Enter").white(" Select\n\n");
        };

        renderPage();
        term.grabInput(true);
        const resizeHandler = () => renderPage();
        process.stdout.on('resize', resizeHandler);

        return new Promise(resolve => {
            term.on('key', (name) => {
                const startIdx = currentPage * ITEMS_PER_PAGE;
                const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, choices.length);
                const pageChoices = choices.slice(startIdx, endIdx);
                const cols = Math.min(5, Math.floor(term.width / 30));
                const rows = Math.ceil(pageChoices.length / cols);

                const localIdx = selectedIdx - startIdx;
                let row = localIdx % rows;
                let col = Math.floor(localIdx / rows);

                if (name === 'LEFT') {
                    if (col > 0) col--;
                    else if (currentPage > 0) {
                        currentPage--;
                        const prevPageCount = Math.min(ITEMS_PER_PAGE, choices.length - (currentPage * ITEMS_PER_PAGE));
                        const prevCols = Math.min(5, Math.floor(term.width / 30));
                        const prevRows = Math.ceil(prevPageCount / prevCols);
                        col = prevCols - 1;
                        row = Math.min(row, prevRows - 1);
                    }
                }
                if (name === 'RIGHT') {
                    if (col < cols - 1 && (col + 1) * rows + row < pageChoices.length) col++;
                    else if (currentPage < totalPages - 1) {
                        currentPage++;
                        col = 0;
                        row = 0;
                    }
                }
                if (name === 'UP') {
                    if (row > 0) row--;
                    else if (currentPage > 0) {
                        currentPage--;
                        const prevPageCount = Math.min(ITEMS_PER_PAGE, choices.length - (currentPage * ITEMS_PER_PAGE));
                        const prevCols = Math.min(5, Math.floor(term.width / 30));
                        const prevRows = Math.ceil(prevPageCount / prevCols);
                        row = prevRows - 1;
                    }
                }
                if (name === 'DOWN') {
                    if (row < rows - 1 && col * rows + row + 1 < pageChoices.length) row++;
                    else if (currentPage < totalPages - 1) {
                        currentPage++;
                        row = 0;
                    }
                }

                selectedIdx = currentPage * ITEMS_PER_PAGE + col * rows + row;
                if (selectedIdx >= choices.length) selectedIdx = choices.length - 1;

                if (['LEFT','RIGHT','UP','DOWN'].includes(name)) renderPage();
                if (name === 'ENTER') {
                    const choice = choices[selectedIdx];
                    process.stdout.off('resize', resizeHandler);
                    term.grabInput(false);
                    resolve(choice);
                }
                if (name === 'ESC') {
                    process.stdout.off('resize', resizeHandler);
                    term.grabInput(false);
                    resolve(null);
                }
            });
        });
    }

    async whitelistSessionId(sessionId) {
        try {
            const url = `https://vlscppe.microsoft.com/tags?org_id=${this.orgId}&session_id=${sessionId}`;
            logger.info(`Whitelisting session ID: ${sessionId}`);
            await axiosWithProxy(url, { headers: this.headers, timeout: 10000 });

            return true;
        } catch (error) {
            logger.error(`Failed to whitelist session ID: ${error.message}`);
            return false;
        }
    }

    async getLanguagesForEdition(selectedVersion, editionIds) {
        const languages = {};
        
        for (let sessionIndex = 0; sessionIndex < editionIds.length; sessionIndex++) {
            const editionId = editionIds[sessionIndex];
            this.sessionIds[sessionIndex] = uuidv4();
            
            const whitelisted = await this.whitelistSessionId(this.sessionIds[sessionIndex]);
            if (!whitelisted) {
                continue;
            }

            try {
                const url = `https://www.microsoft.com/software-download-connector/api/getskuinformationbyproductedition` +
                    `?profile=${this.profileId}` +
                    `&productEditionId=${editionId}` +
                    `&SKU=undefined` +
                    `&friendlyFileName=undefined` +
                    `&Locale=${this.locale}` +
                    `&sessionID=${this.sessionIds[sessionIndex]}`;

                logger.info(`Fetching languages for edition ${editionId}...`);
                let response = null;
                while (!response) {
                    response = await axiosWithProxy(url, { headers: this.headers, timeout: 60000 });
                }


                if (response.data.Errors && response.data.Errors.length > 0) {
                    throw new Error(response.data.Errors[0].Value);
                }

                if (response.data.Skus) {
                    response.data.Skus.forEach(sku => {
                        if (!languages[sku.Language]) {
                            languages[sku.Language] = {
                                displayName: sku.LocalizedLanguage,
                                data: []
                            };
                        }
                        languages[sku.Language].data.push({
                            sessionIndex: sessionIndex,
                            skuId: sku.Id
                        });
                    });
                }
            } catch (error) {
                logger.error(`Failed to get languages for edition ${editionId}: ${error.message}`);
            }
        }

        const languageArray = [];
        Object.keys(languages).forEach(langCode => {
            languageArray.push({
                name: langCode,
                displayName: languages[langCode].displayName,
                data: languages[langCode].data
            });
        });

        return languageArray;
    }

    async getWindowsDownloadLinks(selectedLanguage) {
        const links = [];

        for (const entry of selectedLanguage.data) {
            try {
                const url = `https://www.microsoft.com/software-download-connector/api/GetProductDownloadLinksBySku` +
                    `?profile=${this.profileId}` +
                    `&productEditionId=undefined` +
                    `&SKU=${entry.skuId}` +
                    `&friendlyFileName=undefined` +
                    `&Locale=${this.locale}` +
                    `&sessionID=${this.sessionIds[entry.sessionIndex]}`;

                logger.info(`Getting download links for SKU ${entry.skuId}...`);

                const response = await axiosWithProxy(url, { headers: {
                        ...this.headers,
                        'Referer': this.baseUrl + 'windows11'
                    }, timeout: 60000 });


                if (response.data.Errors && response.data.Errors.length > 0) {
                    if (response.data.Errors[0].Type === 9) {
                        const banMsg = await this.getCode715123130Message();
                        throw new Error(banMsg + this.sessionIds[entry.sessionIndex]);
                    } else {
                        throw new Error(response.data.Errors[0].Value);
                    }
                }

                if (response.data.ProductDownloadOptions) {
                    response.data.ProductDownloadOptions.forEach(option => {
                        const arch = this.getArchFromType(option.DownloadType);
                        links.push({
                            arch: arch,
                            url: option.Uri
                        });
                    });
                }
            } catch (error) {
                logger.error(`Failed to get download links: ${error.message}`);
                throw error;
            }
        }

        return links;
    }

    async getCode715123130Message() {
        try {
            const response = await axiosWithProxy(url + "windows11", { headers: this.headers, timeout: 10000 });

            const html = response.data;
            const msgMatch = html.match(/<input id="msg-01" type="hidden" value="([^"]+)"/);
            if (msgMatch && msgMatch[1]) {
                return msgMatch[1]
                    .replace(/&lt;/g, '<')
                    .replace(/<[^>]+>/g, '')
                    .replace(/\s+/g, ' ');
            }
            throw new Error('Message not found');
        } catch (error) {
            return "Your IP address has been banned by Microsoft for issuing too many ISO download requests or for belonging to a region of the world where sanctions currently apply. Please try again later. If you believe this ban to be in error, you can try contacting Microsoft by referring to message code 715-123130 and session ID ";
        }
    }

    getArchFromType(type) {
        switch(type) {
            case 0: return "x86";
            case 1: return "x64";
            case 2: return "ARM64";
            default: return "Unknown";
        }
    }

    async sendToPipe(pipeName, message) {
        return new Promise((resolve, reject) => {
            const client = net.connect(pipeName, () => {
                client.write(message, 'utf8', () => {
                    client.end();
                    resolve(true);
                });
            });

            client.on('error', (err) => {
                reject(err);
            });

            client.setTimeout(1000, () => {
                client.destroy();
                reject(new Error('Pipe connection timeout'));
            });
        });
    }

    async processDownloadLink(url, pipeName = null) {
        try {
            if (pipeName) {
                await this.sendToPipe(pipeName, url);
                logger.info(`URL sent to pipe: ${pipeName}`);
            } else {}
            return 0;
        } catch (error) {
            logger.error(`Failed to process download link: ${error.message}`);
            return 404;
        }
    }

    async menu(pipeName = null) {
        try {
            term.moveTo(1, 1);
            term.eraseDisplayBelow();

            const versionChoices = this.windowsVersions.map(v => ({ name: v.name, data: v }));
            const selectedVersion = await this.displayPaginatedMenu(versionChoices, this.t('Version'));
            if (!selectedVersion) return null;

            term.moveTo(1, 1);
            term.eraseDisplayBelow();

            const releaseChoices = selectedVersion.data.releases.map(r => ({ name: r.name, data: r }));
            const selectedRelease = await this.displayPaginatedMenu(releaseChoices, this.t('Release'));
            if (!selectedRelease) return null;

            term.moveTo(1, 1);
            term.eraseDisplayBelow();

            const editionChoices = selectedRelease.data.editions.map(e => ({ name: e.name, data: e }));
            const selectedEdition = await this.displayPaginatedMenu(editionChoices, this.t('Edition'));
            if (!selectedEdition) return null;

            term.moveTo(1, 1);
            term.eraseDisplayBelow();
            logger.info(this.t('Please wait...'));

            const languages = await this.getLanguagesForEdition(selectedVersion.data, selectedEdition.data.ids);
            if (!languages || languages.length === 0) {
                throw new Error("No languages found");
            }

            const languageChoices = languages.map(l => ({ name: l.displayName, data: l }));
            const selectedLanguage = await this.displayPaginatedMenu(languageChoices, this.t('Language'));
            if (!selectedLanguage) return null;

            term.moveTo(1, 1);
            term.eraseDisplayBelow();
            logger.info(this.t('Please wait...'));

            let downloadLinks = await this.getWindowsDownloadLinks(selectedLanguage.data);

            if (!downloadLinks || downloadLinks.length === 0) {
                throw new Error("No download links found");
            }

            const archChoices = downloadLinks.map(l => ({ name: l.arch, data: l }));
            const selectedArch = await this.displayPaginatedMenu(archChoices, this.t('Architecture'));
            if (!selectedArch) return null;

            const result = {
                name: `${selectedVersion.data.name}_${selectedEdition.data.name}_${selectedLanguage.data.name}_${selectedArch.data.arch}`,
                url: selectedArch.data.url,
                version: selectedVersion.data.name,
                edition: selectedEdition.data.name,
                language: selectedLanguage.data.displayName,
                arch: selectedArch.data.arch
            };

            term.moveTo(1, 1);
            term.eraseDisplayBelow();
            term.bold.brightGreen(`\n✓ Selected: `).bold.white(`${result.name}\n`);
            term.bold.brightBlue(`  URL: `).white(`${result.url}\n\n`);

            const exitCode = await this.processDownloadLink(result.url, pipeName);
            return { ...result, exitCode };

        } catch (error) {
            logger.error(`Windows downloader error: ${error.message}`);
            return null;
        }
    }
}

module.exports = WindowsDownloader;