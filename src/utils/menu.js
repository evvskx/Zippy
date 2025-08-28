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

    async menu() {
        logger.info(`Version: ${this.architecture_bits}`)

        const choices = Object.keys(this.options);
        if (!choices.length) {
            logger.error(`No ISOs found for ${this.architecture_bits}.`);
            return null;
        }

        const numberedChoices = choices.map((ch, i) => `${i + 1}. ${ch}`);

        const selected = await new Promise(resolve => {
            term.gridMenu(numberedChoices, { exitOnUnexpectedKey: true, columns: 3 }, (error, response) => {
                resolve(choices[response.selectedIndex]);
            });
        });

        const url = this.options[selected];
        logger.info(`Starting download for ${selected}`);
        logger.info(`Sending request to ${url}`);
        return { name: selected, url };
    }
}

module.exports = Menu;
