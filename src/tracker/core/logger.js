import util from 'util';

const COLORS = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
    gray: '\x1b[90m',
    blue: '\x1b[34m',
    brightWhite: '\x1b[97m'
};

function getTimestamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const LEVELS = {
    INFO: { label: 'INFO', color: COLORS.cyan },
    SUCCESS: { label: 'SUCCESS', color: COLORS.green },
    WARN: { label: 'WARN', color: COLORS.yellow },
    ERROR: { label: 'ERROR', color: COLORS.red },
    DEBUG: { label: 'DEBUG', color: COLORS.magenta }
};

function formatMessage(levelKey, tag, message, args = []) {
    const lvl = LEVELS[levelKey] || LEVELS.INFO;
    const timeStr = `${COLORS.gray}[${getTimestamp()}]${COLORS.reset}`;
    const levelStr = `${lvl.color}${COLORS.bold}[${lvl.label}]${COLORS.reset}`;
    const tagStr = tag ? `${COLORS.brightWhite}[${tag}]${COLORS.reset} ` : '';

    let formattedBody = '';
    if (typeof message === 'string') {
        formattedBody = args.length > 0 ? util.format(message, ...args) : message;
    } else {
        formattedBody = util.format(message, ...args);
    }

    return `${timeStr} ${levelStr} ${tagStr}${formattedBody}`;
}

class Logger {
    constructor(tag = null) {
        this._tag = tag;
    }

    tag(name) {
        return new Logger(name);
    }

    info(message, ...args) {
        console.log(formatMessage('INFO', this._tag, message, args));
    }

    success(message, ...args) {
        console.log(formatMessage('SUCCESS', this._tag, message, args));
    }

    warn(message, ...args) {
        console.warn(formatMessage('WARN', this._tag, message, args));
    }

    error(message, ...args) {
        console.error(formatMessage('ERROR', this._tag, message, args));
    }

    debug(message, ...args) {
        console.log(formatMessage('DEBUG', this._tag, message, args));
    }

    log(message, ...args) {
        this.info(message, ...args);
    }
}

/**
 * Module-level logger instance.
 * Call `setLogger(yourLogger)` to swap in a custom implementation
 * (must expose .tag(), .info(), .warn(), .error(), .success(), .debug()).
 */
let _logger = new Logger();

export function setLogger(customLogger) {
    _logger = customLogger;
}

export function getLogger() {
    return _logger;
}

export default _logger;
