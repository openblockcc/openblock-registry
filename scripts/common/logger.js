/**
 * Logger utility for OpenBlock Registry scripts
 */

import chalk from 'chalk';

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3
};

let currentLevel = LOG_LEVELS.INFO;

/**
 * Set log level
 * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
 */
export const setLogLevel = (level) => {
    currentLevel = LOG_LEVELS[level.toUpperCase()] ?? LOG_LEVELS.INFO;
};

/**
 * Format timestamp
 * @returns {string} Formatted timestamp
 */
const timestamp = () => {
    return new Date().toISOString().replace('T', ' ').substring(0, 19);
};

/**
 * Debug log
 * @param {string} message - Message to log
 * @param  {...any} args - Additional arguments
 */
export const debug = (message, ...args) => {
    if (currentLevel <= LOG_LEVELS.DEBUG) {
        console.log(chalk.gray(`[${timestamp()}] [DEBUG] ${message}`), ...args);
    }
};

/**
 * Info log
 * @param {string} message - Message to log
 * @param  {...any} args - Additional arguments
 */
export const info = (message, ...args) => {
    if (currentLevel <= LOG_LEVELS.INFO) {
        console.log(chalk.blue(`[${timestamp()}] [INFO] ${message}`), ...args);
    }
};

/**
 * Success log
 * @param {string} message - Message to log
 * @param  {...any} args - Additional arguments
 */
export const success = (message, ...args) => {
    if (currentLevel <= LOG_LEVELS.INFO) {
        console.log(chalk.green(`[${timestamp()}] [OK] ${message}`), ...args);
    }
};

/**
 * Warning log
 * @param {string} message - Message to log
 * @param  {...any} args - Additional arguments
 */
export const warn = (message, ...args) => {
    if (currentLevel <= LOG_LEVELS.WARN) {
        console.warn(chalk.yellow(`[${timestamp()}] [WARN] ${message}`), ...args);
    }
};

/**
 * Error log
 * @param {string} message - Message to log
 * @param  {...any} args - Additional arguments
 */
export const error = (message, ...args) => {
    if (currentLevel <= LOG_LEVELS.ERROR) {
        console.error(chalk.red(`[${timestamp()}] [ERROR] ${message}`), ...args);
    }
};

/**
 * Log a section header
 * @param {string} title - Section title
 */
export const section = (title) => {
    console.log('');
    console.log(chalk.cyan(`${'='.repeat(60)}`));
    console.log(chalk.cyan.bold(`  ${title}`));
    console.log(chalk.cyan(`${'='.repeat(60)}`));
    console.log('');
};

export default {
    setLogLevel,
    debug,
    info,
    success,
    warn,
    error,
    section
};

