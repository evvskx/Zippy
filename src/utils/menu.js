// src/utils/menu.js
const os = require("os");
const term = require("terminal-kit").terminal;
const logger = require("./logger");
const { checkISO } = require("./checker");
const iso = require("../data/options.json");

class Menu {
    constructor() {
        this.architecture_bits = os.arch().includes('64') ? 'amd_64' : 'i386';
        this.options = {};
    }

    async loadOptions() {
        logger.info("Checking available ISOs...");
        const validISOs = await checkISO(iso); // Now checkISO returns filtered data
        
        // Load options from the filtered valid ISOs
        const archData = validISOs[this.architecture_bits];
        if (!archData) {
            logger.error(`No ISOs found for architecture: ${this.architecture_bits}`);
            this.options = {};
            return;
        }
        
        this.options = archData;
        
        if (!this.options || Object.keys(this.options).length === 0) {
            logger.error("No valid ISOs found for your architecture.");
        }
    }

    async selectOS() {
        const osChoices = Object.keys(this.options);
        if (!osChoices.length) return null;
        const numberedOSChoices = osChoices.map((os, i) => `${i + 1}. ${os.charAt(0).toUpperCase() + os.slice(1)}`);
        return new Promise(resolve => {
            term.gridMenu(numberedOSChoices, { exitOnUnexpectedKey: true, columns: 3 }, (error, response) => {
                if (error || !response) resolve(null);
                else resolve(osChoices[response.selectedIndex]);
            });
        });
    }

    async selectISO(selectedOS) {
        const choices = Object.keys(this.options[selectedOS]);
        if (!choices.length) return null;
        const numberedChoices = choices.map((ch, i) => `${i + 1}. ${ch}`);
        return new Promise(resolve => {
            term.gridMenu(numberedChoices, { exitOnUnexpectedKey: true, columns: 3 }, (error, response) => {
                if (error || !response) resolve(null);
                else resolve({ name: choices[response.selectedIndex], url: this.options[selectedOS][choices[response.selectedIndex]] });
            });
        });
    }

    async menu() {
        logger.info(`Architecture: ${this.architecture_bits}`);
        await this.loadOptions();
        term.clear();
        logger.info("Select Operating System:");
        const selectedOS = await this.selectOS();
        if (!selectedOS) {
            logger.info("No operating system selected.");
            return null;
        }
        term.clear();
        logger.info("Select ISO version:");
        return await this.selectISO(selectedOS);
    }
}

module.exports = Menu;