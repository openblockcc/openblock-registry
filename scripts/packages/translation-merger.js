/**
 * Translation merger module
 * Merges plugin translations into global translation directory
 */

import fs from 'fs/promises';
import path from 'path';
import {execSync} from 'child_process';
import logger from '../common/logger.js';

const TRANSLATION_CATEGORIES = ['interface', 'extensions', 'blocks'];

/**
 * Initialize global translations directory
 * Creates the directory structure and empty JSON files if they don't exist
 * @param {string} targetDir - Target global translations directory
 * @returns {Promise<void>}
 */
export const initTranslationsDir = async (targetDir) => {
    logger.debug(`Initializing translations directory: ${targetDir}`);

    for (const category of TRANSLATION_CATEGORIES) {
        const categoryDir = path.join(targetDir, category);
        await fs.mkdir(categoryDir, {recursive: true});

        const filePath = path.join(categoryDir, 'en.json');
        try {
            await fs.access(filePath);
            logger.debug(`${category}/en.json already exists`);
        } catch {
            await fs.writeFile(filePath, '{}', 'utf-8');
            logger.debug(`Created ${category}/en.json`);
        }
    }
};

/**
 * Merge two translation objects
 * Existing keys are preserved (not overwritten)
 * @param {object} target - Target translation object
 * @param {object} source - Source translation object
 * @returns {{merged: number, skipped: number}} Merge statistics
 */
const mergeTranslationObjects = (target, source) => {
    let merged = 0;
    let skipped = 0;

    for (const [key, value] of Object.entries(source)) {
        if (target[key]) {
            skipped++;
        } else {
            target[key] = value;
            merged++;
        }
    }

    return {merged, skipped};
};

/**
 * Sort object keys alphabetically
 * @param {object} obj - Object to sort
 * @returns {object} New object with sorted keys
 */
const sortObjectKeys = (obj) => {
    const sorted = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys) {
        sorted[key] = obj[key];
    }
    return sorted;
};

/**
 * Merge translations from source directory to target directory
 * @param {string} sourceDir - Source translations directory (.translations/)
 * @param {string} targetDir - Target global translations directory
 * @returns {Promise<{merged: number, skipped: number, categories: object}>}
 */
export const mergeTranslations = async (sourceDir, targetDir) => {
    logger.debug(`Merging translations from ${sourceDir} to ${targetDir}`);

    let totalMerged = 0;
    let totalSkipped = 0;
    const categoryStats = {};

    for (const category of TRANSLATION_CATEGORIES) {
        const sourceFile = path.join(sourceDir, category, 'en.json');
        const targetFile = path.join(targetDir, category, 'en.json');

        // Check if source file exists
        try {
            await fs.access(sourceFile);
        } catch {
            logger.debug(`Source file not found: ${sourceFile}, skipping`);
            categoryStats[category] = {merged: 0, skipped: 0};
            continue;
        }

        // Read source and target
        const sourceContent = await fs.readFile(sourceFile, 'utf-8');
        const sourceData = JSON.parse(sourceContent);

        let targetData = {};
        try {
            const targetContent = await fs.readFile(targetFile, 'utf-8');
            targetData = JSON.parse(targetContent);
        } catch {
            logger.debug(`Target file not found or invalid: ${targetFile}, creating new`);
        }

        // Merge
        const stats = mergeTranslationObjects(targetData, sourceData);
        categoryStats[category] = stats;
        totalMerged += stats.merged;
        totalSkipped += stats.skipped;

        // Sort and write back
        const sortedData = sortObjectKeys(targetData);
        await fs.writeFile(targetFile, JSON.stringify(sortedData, null, 4), 'utf-8');

        logger.debug(`${category}: merged ${stats.merged}, skipped ${stats.skipped}`);
    }

    logger.info(`Translation merge complete: ${totalMerged} merged, ${totalSkipped} skipped`);

    return {
        merged: totalMerged,
        skipped: totalSkipped,
        categories: categoryStats
    };
};

/**
 * Push translations to Transifex
 * @param {string} translationsDir - Translations directory
 * @returns {Promise<{success: boolean, error?: string}>}
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
    initTranslationsDir,
    mergeTranslations,
    pushToTransifex
};

