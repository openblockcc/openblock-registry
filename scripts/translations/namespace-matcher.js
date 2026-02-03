/**
 * Namespace Matcher Module
 * Group translations by plugin ID based on key namespaces
 */

import logger from '../common/logger.js';

/**
 * Extract plugin ID from translation key
 * @param {string} key - Translation key
 * @returns {string|null} Plugin ID or null
 */
const extractPluginId = function (key) {
    // Format 1: "pluginId.something" (interface, extensions)
    const dotMatch = key.split('.');
    if (dotMatch.length > 1) {
        return dotMatch[0];
    }

    // Format 2: "PLUGINID_XXX" (blocks, SCREAMING_CASE)
    const underscoreMatch = key.match(/^([A-Z][A-Z0-9]*)_/);
    if (underscoreMatch) {
        return underscoreMatch[1].toLowerCase();
    }

    return null;
};

/**
 * Group translations by plugin ID
 * @param {object} allTranslations - All translations from Transifex
 * @param {string[]} pluginIds - List of plugin IDs
 * @returns {object} Translations grouped by plugin ID
 */
export const groupByNamespace = function (allTranslations, pluginIds) {
    const result = {};
    
    // Initialize structure for each plugin
    for (const pluginId of pluginIds) {
        result[pluginId] = {
            interface: {},
            extensions: {},
            blocks: {}
        };
    }
    
    // Group translations
    for (const resource of ['interface', 'extensions', 'blocks']) {
        const resourceData = allTranslations[resource] || {};
        
        for (const [locale, translations] of Object.entries(resourceData)) {
            for (const [key, value] of Object.entries(translations)) {
                const pluginId = extractPluginId(key);
                
                if (pluginId && result[pluginId]) {
                    if (!result[pluginId][resource][locale]) {
                        result[pluginId][resource][locale] = {};
                    }
                    result[pluginId][resource][locale][key] = value;
                }
            }
        }
    }
    
    // Log statistics
    logger.info('Translation statistics by plugin:');
    for (const pluginId of pluginIds) {
        const counts = {
            interface: Object.keys(result[pluginId].interface.en || {}).length,
            extensions: Object.keys(result[pluginId].extensions.en || {}).length,
            blocks: Object.keys(result[pluginId].blocks.en || {}).length
        };
        const total = counts.interface + counts.extensions + counts.blocks;
        if (total > 0) {
            logger.debug(`  ${pluginId}: ${counts.interface}i + ${counts.extensions}e + ${counts.blocks}b = ${total}`);
        }
    }

    return result;
};

export default {
    groupByNamespace
};
