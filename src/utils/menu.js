const os = require("os");
const term = require("terminal-kit").terminal;
const logger = require("./logger");
const { checkISO } = require("./checker");
const WindowsDownloader = require("./windows");

class Menu {
    constructor() {
        this.architecture_bits = null;
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
        const isoUrl = "https://evvskx.github.io/Zippy/urls.json";
        const allISOs = await checkISO(isoUrl);
        this.options = {
            "Linux": {
                "amd64": allISOs.amd_64.Linux,
                "i386": allISOs.i386.Linux
            },
            "Windows": "windows stinks"
        };
    }

    padRight(str, width) {
        const len = [...str].length;
        return str + ' '.repeat(Math.max(0, width - len));
    }

    async displayPaginatedMenu(choices, title) {
        this.termWidth = term.width;
        this.termHeight = term.height;
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
            const cols = Math.min(5, Math.floor(this.termWidth / 30));
            const rows = Math.ceil(pageChoices.length / cols);
            for (let row = 0; row < rows; row++) {
                let rowText = '';
                for (let col = 0; col < cols; col++) {
                    const idx = col * rows + row;
                    if (idx < pageChoices.length) {
                        const globalIdx = startIdx + idx;
                        const choice = pageChoices[idx];
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
            term.brightGreen("Enter").white(" Select \n\n");
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
                const cols = Math.min(5, Math.floor(this.termWidth / 30));
                const rows = Math.ceil(pageChoices.length / cols);

                const localIdx = selectedIdx - startIdx;
                let row = localIdx % rows;
                let col = Math.floor(localIdx / rows);

                if (name === 'LEFT') {
                    if (col > 0) col--;
                    else if (currentPage > 0) {
                        currentPage--;
                        const prevPageCount = Math.min(ITEMS_PER_PAGE, choices.length - (currentPage * ITEMS_PER_PAGE));
                        const prevCols = Math.min(5, Math.floor(this.termWidth / 30));
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
                        const prevCols = Math.min(5, Math.floor(this.termWidth / 30));
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

    async selectArchitecture() {
        const archChoices = ["32bit", "64bit"];
        const selected = await this.displayPaginatedMenu(archChoices, "Select Architecture");
        if (!selected) return null;
        if (selected.includes("32")) return "i386";
        if (selected.includes("64")) return "amd64";
        return null;
    }

    async selectOS() {
        const osChoices = Object.keys(this.options);
        if (!osChoices.length) return null;
        if (osChoices.length === 1) {
            const singleChoice = osChoices[0];
            term.moveTo(1,1);
            term.eraseDisplayBelow();
            return singleChoice;
        }
        const sortedChoices = osChoices.sort(this.compareDistros.bind(this));
        const groupedChoices = this.groupByDistribution(sortedChoices);
        const flatChoices = this.flattenGroupedChoices(groupedChoices);
        return await this.displayPaginatedMenu(flatChoices, "Select Operating System");
    }

    async selectISO(selectedOS) {
        const choices = Object.keys(this.options[selectedOS][this.architecture_bits]);
        if (!choices.length) return null;
        if (choices.length === 1) {
            const singleChoice = choices[0];
            term.moveTo(1,1);
            term.eraseDisplayBelow();
            term.bold.brightGreen(`\nV Found single ISO: `).bold.white(`${singleChoice}\n`);
            term.bold.white("Proceeding with this ISO...\n");
            await new Promise(resolve => setTimeout(resolve, 1000));
            return { name: singleChoice, url: this.options[selectedOS][this.architecture_bits][singleChoice] };
        }
        const sortedChoices = choices.sort(this.compareDistros.bind(this));
        const selectedChoice = await this.displayPaginatedMenu(sortedChoices, `Select ISO for ${selectedOS}: ${this.architecture_bits}`);
        if (!selectedChoice) return null;
        return { name: selectedChoice, url: this.options[selectedOS][this.architecture_bits][selectedChoice] };
    }

    async menu() {
        await this.loadOptions();
        const osChoices = Object.keys(this.options);
        if (!osChoices.length) {
            term.brightRed("X No operating systems available.\n");
            return null;
        }

        const selectedOS = await this.displayPaginatedMenu(osChoices, "Select Operating System");
        if (!selectedOS) {
            term.brightRed("X No operating system selected.\n");
            return null;
        } else if (selectedOS === "Windows") {
            const windowsMenu = new WindowsDownloader();
            return await windowsMenu.menu();
        } else {
            this.architecture_bits = await this.selectArchitecture();
            if (!this.architecture_bits) {
                term.brightRed("X No architecture selected.\n");
                return null;
            }
        }

        const result = await this.selectISO(selectedOS);
        if (result) {
            term.moveTo(1,1);
            term.eraseDisplayBelow();
            term.bold.brightGreen(`\nv Selected: `).bold.white(`${result.name}\n`);
            term.bold.brightBlue(`  URL: `).white(`${result.url}\n\n`);
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