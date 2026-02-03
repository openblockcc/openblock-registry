/**
 * Translation merger module
 * Manages plugin translations stored in R2 and synced to Transifex
 */

import fs from 'fs/promises';
import path from 'path';
import {execSync} from 'child_process';
import logger from '../common/logger.js';
import {downloadJson, uploadJson} from '../common/r2-client.js';

const TRANSLATION_CATEGORIES = ['interface', 'extensions', 'blocks'];
const R2_TRANSLATIONS_PATH = 'translations';

/**
 * Extract plugin ID from translation key
 * @param {string} key - Translation key
 * @param {string} category - Category (interface/extensions/blocks)
 * @returns {string|null} Plugin ID (lowercase)
 */
const extractPluginId = (key, category) => {
    if (category === 'blocks') {
        // Format: "PLUGINID_XXX" -> extract PLUGINID and convert to lowercase
        const match = key.match(/^([A-Z][A-Z0-9]*)_/);
        return match ? match[1].toLowerCase() : null;
    }
    // Format: "pluginId.something" -> extract pluginId
    const parts = key.split('.');
    return parts.length > 1 ? parts[0] : null;
};

/**
 * Remove plugin's translations from translation object
 * @param {object} translations - Translation object
 * @param {string} pluginId - Plugin ID to remove (lowercase)
 * @param {string} category - Category (interface/extensions/blocks)
 * @returns {object} Translations with plugin removed
 */
const removePluginTranslations = (translations, pluginId, category) => {
    const result = {};
    for (const [key, value] of Object.entries(translations)) {
        const keyPluginId = extractPluginId(key, category);
        if (keyPluginId !== pluginId) {
            result[key] = value;
        }
    }
    return result;
};

/**
 * Sort translations by namespace (plugin ID) then by key
 * @param {object} translations - Translation object
 * @param {string} category - Category (interface/extensions/blocks)
 * @returns {object} Sorted translations
 */
const sortByNamespace = (translations, category) => {
    // Group by plugin ID
    const grouped = {};
    for (const [key, value] of Object.entries(translations)) {
        const pluginId = extractPluginId(key, category) || '_unknown';
        if (!grouped[pluginId]) grouped[pluginId] = {};
        grouped[pluginId][key] = value;
    }

    // Sort plugin IDs alphabetically
    const sortedPluginIds = Object.keys(grouped).sort();

    // Build sorted result: each plugin's keys are also sorted
    const result = {};
    for (const pluginId of sortedPluginIds) {
        const keys = Object.keys(grouped[pluginId]).sort();
        for (const key of keys) {
            result[key] = grouped[pluginId][key];
        }
    }

    return result;
};

/**
 * Fetch all translations from R2
 * @returns {Promise<object>} Translations by category {interface: {}, extensions: {}, blocks: {}}
 */
export const fetchTranslationsFromR2 = async () => {
    logger.info('Fetching translations from R2...');
    const translations = {
        interface: {},
        extensions: {},
        blocks: {}
    };

    for (const category of TRANSLATION_CATEGORIES) {
        const remotePath = `${R2_TRANSLATIONS_PATH}/${category}/en.json`;
        const data = await downloadJson(remotePath);
        if (data) {
            translations[category] = data;
            logger.debug(`Loaded ${category}: ${Object.keys(data).length} keys`);
        } else {
            logger.debug(`No existing ${category} translations in R2`);
        }
    }

    const totalKeys = Object.values(translations).reduce((sum, cat) => sum + Object.keys(cat).length, 0);
    logger.info(`Loaded ${totalKeys} total translation keys from R2`);

    return translations;
};

/**
 * Upload all translations to R2
 * @param {object} translations - Translations by category
 * @returns {Promise<void>} Promise that resolves when upload is complete
 */
export const uploadTranslationsToR2 = async (translations) => {
    logger.info('Uploading translations to R2...');

    for (const category of TRANSLATION_CATEGORIES) {
        const remotePath = `${R2_TRANSLATIONS_PATH}/${category}/en.json`;
        await uploadJson(translations[category], remotePath);
    }

    const totalKeys = Object.values(translations).reduce((sum, cat) => sum + Object.keys(cat).length, 0);
    logger.success(`Uploaded ${totalKeys} total translation keys to R2`);
};

/**
 * Initialize local translations directory from R2 data
 * @param {string} targetDir - Target local translations directory
 * @param {object} translations - Translations from R2
 * @returns {Promise<void>} Promise that resolves when initialization is complete
 */
export const initTranslationsDir = async (targetDir, translations) => {
    logger.debug(`Initializing local translations directory: ${targetDir}`);

    for (const category of TRANSLATION_CATEGORIES) {
        const categoryDir = path.join(targetDir, category);
        await fs.mkdir(categoryDir, {recursive: true});

        const filePath = path.join(categoryDir, 'en.json');
        const data = translations[category] || {};
        await fs.writeFile(filePath, JSON.stringify(data, null, 4), 'utf-8');
        logger.debug(`Wrote ${category}/en.json with ${Object.keys(data).length} keys`);
    }
};

/**
 * Merge plugin translations into global translations (R2-based)
 * Removes old translations for this plugin, adds new ones, and sorts by namespace
 * @param {string} sourceDir - Source translations directory from plugin (.translations/)
 * @param {object} globalTranslations - Global translations object from R2
 * @param {string} pluginId - Plugin ID (lowercase)
 * @returns {Promise<object>} Merge statistics {added, removed, updated}
 */
export const mergePluginTranslations = async (sourceDir, globalTranslations, pluginId) => {
    logger.debug(`Merging translations for plugin: ${pluginId}`);

    let totalAdded = 0;
    let totalRemoved = 0;
    let totalUpdated = 0;

    for (const category of TRANSLATION_CATEGORIES) {
        const sourceFile = path.join(sourceDir, category, 'en.json');

        // Read source translations for this plugin
        let sourceData = {};
        try {
            const content = await fs.readFile(sourceFile, 'utf-8');
            sourceData = JSON.parse(content);
        } catch {
            logger.debug(`No ${category} translations for ${pluginId}`);
            continue;
        }

        const sourceKeys = Object.keys(sourceData);
        if (sourceKeys.length === 0) continue;

        // Count existing keys for this plugin before removal
        const beforeRemoval = Object.keys(globalTranslations[category]).filter(
            key => extractPluginId(key, category) === pluginId
        ).length;

        // Remove old translations for this plugin
        globalTranslations[category] = removePluginTranslations(
            globalTranslations[category],
            pluginId,
            category
        );

        totalRemoved += beforeRemoval;

        // Add new translations
        for (const [key, value] of Object.entries(sourceData)) {
            globalTranslations[category][key] = value;
        }
        totalAdded += sourceKeys.length;

        // Sort by namespace
        globalTranslations[category] = sortByNamespace(globalTranslations[category], category);

        logger.debug(`${category}: removed ${beforeRemoval}, added ${sourceKeys.length}`);
    }

    // Calculate net change
    totalUpdated = Math.min(totalAdded, totalRemoved);
    const netAdded = totalAdded - totalUpdated;
    const netRemoved = totalRemoved - totalUpdated;

    logger.info(`Plugin ${pluginId}: +${netAdded} -${netRemoved} ~${totalUpdated}`);

    return {
        added: netAdded,
        removed: netRemoved,
        updated: totalUpdated
    };
};

/**
 * Legacy merge function - kept for backwards compatibility
 * @deprecated Use mergePluginTranslations with R2 workflow instead
 * @param {string} sourceDir - Source translations directory from plugin
 * @param {string} targetDir - Target translations directory
 * @returns {Promise<object>} Merge statistics with merged, skipped, and categories properties
 */
export const mergeTranslations = async (sourceDir, targetDir) => {
    logger.warn('Using deprecated mergeTranslations - consider switching to R2-based workflow');

    // Read existing target data
    const globalTranslations = {interface: {}, extensions: {}, blocks: {}};

    for (const category of TRANSLATION_CATEGORIES) {
        const targetFile = path.join(targetDir, category, 'en.json');
        try {
            const content = await fs.readFile(targetFile, 'utf-8');
            globalTranslations[category] = JSON.parse(content);
        } catch {
            // File doesn't exist, start with empty
        }
    }

    // Extract plugin ID from source translations
    let pluginId = null;
    for (const category of TRANSLATION_CATEGORIES) {
        const sourceFile = path.join(sourceDir, category, 'en.json');
        try {
            const content = await fs.readFile(sourceFile, 'utf-8');
            const data = JSON.parse(content);
            const firstKey = Object.keys(data)[0];
            if (firstKey) {
                pluginId = extractPluginId(firstKey, category);
                break;
            }
        } catch {
            continue;
        }
    }

    if (!pluginId) {
        logger.warn('Could not determine plugin ID from translations');
        return {merged: 0, skipped: 0, categories: {}};
    }

    // Use new merge logic
    const stats = await mergePluginTranslations(sourceDir, globalTranslations, pluginId);

    // Write back to target directory
    for (const category of TRANSLATION_CATEGORIES) {
        const targetFile = path.join(targetDir, category, 'en.json');
        await fs.writeFile(targetFile, JSON.stringify(globalTranslations[category], null, 4), 'utf-8');
    }

    return {
        merged: stats.added + stats.updated,
        skipped: 0,
        categories: {}
    };
};

/**
 * Push translations to Transifex
 * @param {string} translationsDir - Translations directory
 * @returns {Promise<object>} Push result with success and error properties
 */
export const pushToTransifex = async (translationsDir) => {
    logger.info('Pushing translations to Transifex...');

    try {
        const command = `npx openblock-registry-cli i18n push --dir=${translationsDir}`;
        
        execSync(command, {
            stdio: 'inherit',
            encoding: 'utf-8'
        });

        logger.success('Translations pushed to Transifex');
        return {success: true};

    } catch (err) {
        logger.error(`Failed to push translations: ${err.message}`);
        return {
            success: false,
            error: err.message
        };
    }
};

export default {
    fetchTranslationsFromR2,
    uploadTranslationsToR2,
    initTranslationsDir,
    mergePluginTranslations,
    mergeTranslations,
    pushToTransifex
};
