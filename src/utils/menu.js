const os = require("os");
const term = require("terminal-kit").terminal;
const logger = require("./logger");
const { checkISO } = require("./checker");
const WindowsDownloader = require("./windows");

class Menu {
    constructor() {
        this.architecture_bits = os.arch().includes('64') ? 'amd_64' : 'i386';
        this.options = {};
        this.termWidth = term.width;
        this.termHeight = term.height;
    }

    calculateItemsPerPage() {
        const MIN_ITEMS = 5;
        if (this.termWidth >= 120 && this.termHeight >= 40) return 35;
        if (this.termWidth >= 80 && this.termHeight >= 30) return 20;
        return MIN_ITEMS;
    }

    parseVersion(str) {
        const match = str.match(/(\d+(?:\.\d+)*)(?!.*\d)/);
        if (!match) return null;
        return match[1].split(".").map(n => parseInt(n, 10));
    }

    compareVersionsDesc(a, b) {
        const va = this.parseVersion(a);
        const vb = this.parseVersion(b);
        if (va && vb) {
            const len = Math.max(va.length, vb.length);
            for (let i = 0; i < len; i++) {
                const na = va[i] || 0;
                const nb = vb[i] || 0;
                if (na !== nb) return nb - na;
            }
        }
        if (va && !vb) return -1;
        if (!va && vb) return 1;
        return 0;
    }

    distroName(str) {
        const match = str.match(/^([a-zA-Z\s]+)/);
        return match ? match[1].trim().toLowerCase() : str.toLowerCase();
    }

    compareDistros(a, b) {
        const da = this.distroName(a);
        const db = this.distroName(b);
        if (da !== db) return da.localeCompare(db);
        const versionCompare = this.compareVersionsDesc(a, b);
        if (versionCompare !== 0) return versionCompare;
        return a.localeCompare(b, undefined, { sensitivity: "base" });
    }

    async loadOptions() {
        logger.info("Checking available ISOs...");
        const isoUrl = "https://evvskx.github.io/Zippy/urls.json";
        const validISOs = await checkISO(isoUrl);
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

    padRight(str, width) {
        const len = [...str].length;
        return str + ' '.repeat(Math.max(0, width - len));
    }

    async selectOS() {
        const osChoices = Object.keys(this.options);
        if (!osChoices.length) return null;
        if (osChoices.length === 1) return osChoices[0];
        const sortedChoices = osChoices.sort(this.compareDistros.bind(this));
        const groupedChoices = this.groupByDistribution(sortedChoices);
        const flatChoices = this.flattenGroupedChoices(groupedChoices);
        const choice = await this.displayPaginatedMenu(flatChoices, "Select Operating System");
        if (choice === "Windows") {
            const windows = new WindowsDownloader();
            const arch = this.architecture_bits.includes("64") ? "64-bit" : "32-bit";
            return await windows.menu(arch);
        }
        return choice;
    }

    async selectISO(selectedOS) {
        if (selectedOS && selectedOS.version) return selectedOS;
        const choices = Object.keys(this.options[selectedOS]);
        if (!choices.length) return null;
        if (choices.length === 1) return { name: choices[0], url: this.options[selectedOS][choices[0]] };
        const sortedChoices = choices.sort(this.compareDistros.bind(this));
        const selectedChoice = await this.displayPaginatedMenu(sortedChoices, `Select ISO for ${selectedOS}: ${this.architecture_bits}`);
        if (!selectedChoice) return null;
        return { name: selectedChoice, url: this.options[selectedOS][selectedChoice] };
    }

    groupByDistribution(choices) {
        const groups = {};
        choices.forEach(choice => {
            const distro = this.distroName(choice);
            if (!groups[distro]) groups[distro] = [];
            groups[distro].push(choice);
        });
        Object.keys(groups).forEach(distro => {
            groups[distro].sort(this.compareVersionsDesc.bind(this));
        });
        return groups;
    }

    flattenGroupedChoices(groupedChoices) {
        const orderedDistros = Object.keys(groupedChoices).sort();
        const flatChoices = [];
        orderedDistros.forEach(distro => {
            flatChoices.push(...groupedChoices[distro]);
        });
        return flatChoices;
    }

    async menu() {
        logger.info(`Architecture: ${this.architecture_bits}`);
        await this.loadOptions();
        const allChoices = Object.keys(this.options).sort(this.compareDistros.bind(this));
        if (allChoices.length > 20) await this.displaySummary(allChoices);
        term.moveTo(1,1);
        term.eraseDisplayBelow();
        const selectedOS = await this.selectOS();
        if (!selectedOS) {
            term.brightRed("X No operating system selected.\n");
            return null;
        }
        term.moveTo(1,1);
        term.eraseDisplayBelow();
        const result = await this.selectISO(selectedOS);
        if (result) {
            term.moveTo(1,1);
            term.eraseDisplayBelow();
            if (result.version) {
                term.bold.brightGreen(`\nV Selected Windows: `).bold.white(`${result.version} ${result.edition} ${result.arch} ${result.lang}\n`);
                term.bold.brightBlue(`  URL: `).white(`${result.url}\n\n`);
            } else {
                term.bold.brightGreen(`\nV Selected: `).bold.white(`${result.name}\n`);
                term.bold.brightBlue(`  URL: `).white(`${result.url}\n\n`);
            }
        } else {
            term.brightRed("X No ISO version selected.\n");
        }
        return result;
    }

    async displaySummary(choices) {
        term.moveTo(1,1);
        term.eraseDisplayBelow();
        term.bold.brightCyan(`\n╔════════════════════════════════════════════════════════════════════════╗\n`);
        term.bold.brightCyan(`║`).bold.white(this.padRight(` Available ISO Summary`, 72)).bold.brightCyan(`║\n`);
        term.bold.brightCyan(`╚════════════════════════════════════════════════════════════════════════╝\n\n`);
        const grouped = this.groupByDistribution(choices);
        Object.keys(grouped).sort().forEach(distro => {
            const count = grouped[distro].length;
            term.bold.brightCyan(`${distro.toUpperCase()}`).white(` (${count} versions)\n`);
            const examples = grouped[distro].slice(0, 3);
            examples.forEach(version => term.white(`  • ${version}\n`));
            if (count > 3) term.gray(`  ... and ${count - 3} more versions\n`);
            term.white('\n');
        });
        term.bold.brightGreen(`Total: ${choices.length} ISO options available\n\n`);
        term.bold.white("Press any key to continue...");
        await term.inputField({ echo: false, maxLength: 1 }).promise;
    }
}

module.exports = Menu;
