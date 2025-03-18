import winston, { level } from 'winston';
import path from 'path';

// Create a custom format to add caller information
const callerFormat = winston.format((info: winston.Logform.TransformableInfo & { stack?: string }) => {
    if (!info.stack) {
        return info;
    }

    const stackLines = info.stack.split('\n');
    for (const line of stackLines) {
        if (line.trim().startsWith('at ') && !line.includes('logger.') && !line.includes('node_modules/') && !line.includes('combine.js')) {
            const match = line.match(/(?:.*\((.+):(\d+):(\d+)\))|(?:at\s+(.+):(\d+):(\d+))/);
            if (match) {
                const filePath = match[1] || match[4];
                const lineNumber = match[2] || match[5];
                if (filePath) {
                    const filename = path.basename(filePath);
                    const moduleName = path.dirname(filePath).split(path.sep).pop() || 'aggreagtor';
                    info.caller = `${moduleName}/${filename}:${lineNumber}`;
                    break;
                }
            }
        }
    }

    delete info.stack;
    return info;
});

// Determine log level based on environment and args
function getLogLevel(): string {
    // Check command line args for --verbose or -v
    const args = process.argv.slice(2);
    if (args.includes('--verbose') || args.includes('-v')) {
        return 'debug';
    }

    // Check if running in debug mode
    const isDebuggerAttached = process.env.NODE_OPTIONS?.includes('--inspect')
        || process.env.NODE_OPTIONS?.includes('--inspect-brk')
        || /--debug|--inspect/.test(process.execArgv.join(' '));

    return isDebuggerAttached ? 'debug' : 'info';
}

// Modify the logger creation to capture stack traces
const baseLogger = winston.createLogger({
    level: getLogLevel(),  // Dynamically set log level
    format: winston.format.combine(
        winston.format((info: any) => {
            // Capture stack trace when the log is created
            const error = new Error();
            Error.captureStackTrace(error);
            info.stack = error.stack;
            return info;
        })(),
        callerFormat(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss:SSS' }),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, caller, ...meta }) => {
            // Custom replacer function to handle BigInt
            const replacer = (key: string, value: any) => {
                if (typeof value === 'bigint') {
                    return value.toString();
                }
                return value;
            };
            let module = '';
            if (meta && meta.module) {
                module = meta.module as string;
                delete meta.module;
            }

            const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta, replacer) : '';
            const moduleStr = module ? ` \x1b[94m[${module}]\x1b[0m` : '';
            const callerStr = caller ? ` \x1b[90m[${caller}]\x1b[0m` : '';
            return `\x1b[36m${timestamp}\x1b[0m ${level}${moduleStr}${callerStr} ${message}${metaStr}`;
        })
    ),
    transports: [
        new winston.transports.Console({ forceConsole: true })
    ]
});

const logger = baseLogger.child({ module: 'Logger' });

// Test logs at different levels
logger.debug('Logger initialized (debug)');
logger.info('Logger initialized (info)');

export default baseLogger;