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
        const validISOs = await checkISO(iso);
        this.options = validISOs[this.architecture_bits] || {};
    }

    async selectOS() {
        const osChoices = Object.keys(this.options);
        if (!osChoices.length) {
            logger.error(`No valid operating systems found for ${this.architecture_bits}.`);
            return null;
        }

        const numberedOSChoices = osChoices.map((os, i) => `${i + 1}. ${os.charAt(0).toUpperCase() + os.slice(1)}`);

        return new Promise(resolve => {
            term.gridMenu(numberedOSChoices, { exitOnUnexpectedKey: true, columns: 3 }, (error, response) => {
                if (error || !response) {
                    resolve(null);
                } else {
                    resolve(osChoices[response.selectedIndex]);
                }
            });
        });
    }

    async selectISO(selectedOS) {
        const choices = Object.keys(this.options[selectedOS]);
        if (!choices.length) {
            logger.error(`No valid ISOs found for ${selectedOS} on ${this.architecture_bits}.`);
            return null;
        }

        const numberedChoices = choices.map((ch, i) => `${i + 1}. ${ch}`);

        return new Promise(resolve => {
            term.gridMenu(numberedChoices, { exitOnUnexpectedKey: true, columns: 3 }, (error, response) => {
                if (error || !response) {
                    resolve(null);
                } else {
                    resolve({ name: choices[response.selectedIndex], url: this.options[selectedOS][choices[response.selectedIndex]] });
                }
            });
        });
    }

    async menu() {
        logger.info(`Architecture: ${this.architecture_bits}`);
        term.clear();

        await this.loadOptions();

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
