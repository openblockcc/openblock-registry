/**
 * Transifex Puller Module
 * Pull all reviewed translations from Transifex
 */

import locales from 'openblock-l10n';
import {txPull} from 'openblock-l10n/lib/transifex.js';
import logger from '../common/logger.js';

const PROJECT = 'openblock-resources';
const RESOURCES = ['interface', 'extensions', 'blocks'];
const MODE = 'reviewed';

const LOCALE_MAP = {
    'aa-dj': 'aa_DJ',
    'es-419': 'es_419',
    'pt-br': 'pt_BR',
    'zh-cn': 'zh_CN',
    'zh-tw': 'zh_TW'
};

/**
 * Normalize translation data from Transifex format to simple key-value pairs
 * Transifex returns: {key: {message: '...', description: '...'}}
 * We need: {key: '...'}
 * @param {object} data - Raw data from Transifex
 * @returns {object} Normalized translations
 */
const normalizeTranslations = function (data) {
    const normalized = {};
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string') {
            // Already a string, use as-is
            normalized[key] = value;
        } else if (value && typeof value === 'object' && value.message) {
            // Extract message field from object
            normalized[key] = value.message;
        } else if (value && typeof value === 'object' && value.description) {
            // Fallback to description if message is not available
            normalized[key] = value.description;
        }
        // Skip if value is null, undefined, or empty object
    }
    return normalized;
};

/**
 * Pull all translations from Transifex
 * @returns {Promise<object>} Translations organized by resource -> locale -> key -> value
 */
export const pullAllTranslations = async function () {
    logger.info('Pulling translations from Transifex...');

    const allTranslations = {
        interface: {},
        extensions: {},
        blocks: {}
    };

    const localeList = Object.keys(locales.default);

    for (const resource of RESOURCES) {
        logger.info(`  Pulling ${resource}...`);

        for (const locale of localeList) {
            const txLocale = LOCALE_MAP[locale] || locale;
            try {
                const data = await txPull(PROJECT, resource, txLocale, MODE);
                // Normalize the data to simple key-value pairs
                allTranslations[resource][locale] = normalizeTranslations(data || {});
            } catch (err) {
                logger.warn(`    Failed to pull ${resource}/${locale}: ${err.message}`);
                allTranslations[resource][locale] = {};
            }
        }
    }

    logger.success('Translations pulled successfully');
    return allTranslations;
};

export default {
    pullAllTranslations
};
