const axios = require("axios");
const fs = require("fs");
const path = require("path");
const term = require("terminal-kit").terminal;

// load utils.
fs.readdirSync(path.join(__dirname, "utils")).forEach(file => {
    if (file.endsWith(".js")) {
        const moduleName = path.basename(file, ".js");
        global[moduleName] = require(`./utils/${file}`);
    }
});

// fix ctrl c
term.on('key', (name) => {
    if (name === 'CTRL_C') {
        term.grabInput(false);
        term.clear();
        process.exit();
    }
});
(async () => {
    await checker.checkISO();

    logger.info("Resources loaded successfully.");

    term.clear();
    const m = new menu();
    const selectedISO = await m.menu();

    if (selectedISO) {
        await download.downloadISO(selectedISO.url, selectedISO.name);
        process.exit();
    }
})();
