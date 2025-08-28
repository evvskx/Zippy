const colors = {
    Reset: "\x1b[0m",
    FgRed: "\x1b[31m",
    FgGreen: "\x1b[32m",
    FgYellow: "\x1b[33m",
    FgCyan: "\x1b[36m",
    FgBlue: "\x1b[34m",
    FgWhite: "\x1b[37m",
    FgMagenta: "\x1b[35m"
};

const timestamp = () => `${colors.FgCyan}${new Date().toISOString()}${colors.Reset}`;

const info = (...args) =>
    console.log(`${timestamp()} - ${colors.FgBlue}[INFO]${colors.Reset} - ${colors.FgWhite}${args.join(" ")}${colors.Reset}`);

const inlineInfo = (...args) => {
    process.stdout.write(
        `\r${timestamp()} - ${colors.FgBlue}[INFO]${colors.Reset} - ${colors.FgWhite}${args.join(" ")}${colors.Reset}`
    );
};

const error = (...args) =>
    console.error(`${timestamp()} - ${colors.FgRed}[ERROR]${colors.Reset} - ${colors.FgWhite}${args.join(" ")}${colors.Reset}`);

const success = (...args) =>
    console.log(`${timestamp()} - ${colors.FgGreen}[SUCCESS]${colors.Reset} - ${colors.FgWhite}${args.join(" ")}${colors.Reset}`);

const warning = (...args) =>
    console.warn(`${timestamp()} - ${colors.FgYellow}[WARNING]${colors.Reset} - ${colors.FgWhite}${args.join(" ")}${colors.Reset}`);

module.exports = { info, inlineInfo, error, success, warning };
