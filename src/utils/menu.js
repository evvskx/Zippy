const fs = require("fs");
const path = require("path");
const os = require("os");
const term = require("terminal-kit").terminal;
const logger = require("./logger");

class Menu {
    constructor() {
        this.architecture_bits = os.arch().includes('64') ? 'amd_64' : 'i386';
        const options = JSON.parse(fs.readFileSync(path.join(__dirname, "../data/options.json"), "utf8"));
        this.options = options[this.architecture_bits] || {};
    }

    async selectOS() {
        const osChoices = Object.keys(this.options);
        if (!osChoices.length) {
            logger.error(`No operating systems found for ${this.architecture_bits}.`);
            return null;
        }

        const numberedOSChoices = osChoices.map((os, i) => `${i + 1}. ${os.charAt(0).toUpperCase() + os.slice(1)}`);

        const selectedOS = await new Promise(resolve => {
            term.gridMenu(numberedOSChoices, { exitOnUnexpectedKey: true, columns: 3 }, (error, response) => {
                if (error || !response) {
                    resolve(null);
                } else {
                    resolve(osChoices[response.selectedIndex]);
                }
            });
        });

        return selectedOS;
    }

    async selectISO(selectedOS) {
        const choices = Object.keys(this.options[selectedOS]);
        if (!choices.length) {
            logger.error(`No ISOs found for ${selectedOS} on ${this.architecture_bits}.`);
            return null;
        }

        const numberedChoices = choices.map((ch, i) => `${i + 1}. ${ch}`);

        const selected = await new Promise(resolve => {
            term.gridMenu(numberedChoices, { exitOnUnexpectedKey: true, columns: 3 }, (error, response) => {
                if (error || !response) {
                    resolve(null);
                } else {
                    resolve(choices[response.selectedIndex]);
                }
            });
        });

        if (!selected) return null;

        const url = this.options[selectedOS][selected];
        return { name: selected, url };
    }

    async menu() {
        logger.info(`Architecture: ${this.architecture_bits}`);

        term.clear();
        logger.info("Select Operating System:");
        const selectedOS = await this.selectOS();
        
        if (!selectedOS) {
            logger.info("No operating system selected.");
            return null;
        }

        term.clear();
        logger.info("Select ISO version:");
        const selectedISO = await this.selectISO(selectedOS);

        return selectedISO;
    }
}

module.exports = Menu;