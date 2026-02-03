#!/usr/bin/env node

/**
 * Sync translations from Transifex to plugin repositories
 *
 * Usage:
 *   node translations/sync.js [options]
 *
 * Options:
 *   --dry-run       Preview changes without creating PRs
 *   --plugin=ID     Only sync specific plugin (repo name)
 */

import path from 'path';
import {fileURLToPath} from 'url';
import {pullAllTranslations} from './transifex-puller.js';
import {groupByNamespace} from './namespace-matcher.js';
import {compareTranslations, mergeTranslations} from './translation-differ.js';
import {parseTranslationsJs, generateTranslationsJs} from './translation-generator.js';
import {createTranslationPR} from './github-pr.js';
import {readRegistryJson, parseRepoUrl} from '../packages/calculate-diff.js';
import logger from '../common/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fetch file content via raw URL
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} ref - Git ref
 * @param {string} filePath - File path
 * @returns {Promise<string>} File content
 */
const fetchRawFile = async function (owner, repo, ref, filePath) {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${filePath}: ${response.status}`);
    }
    return response.text();
};

/**
 * Parse command line arguments
 * @returns {object} Parsed arguments
 */
const parseArgs = function () {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            args[key] = value || true;
        }
    });
    return args;
};

/**
 * Process a single plugin
 * @param {object} options - Options
 * @returns {Promise<object>} Result
 */
const processPlugin = async function (options) {
    const {owner, repo, pluginTranslations, dryRun} = options;
    
    logger.info(`Processing ${owner}/${repo}...`);
    
    try {
        // 1. Get package.json
        const packageContent = await fetchRawFile(owner, repo, 'HEAD', 'package.json');
        const pkg = JSON.parse(packageContent);
        
        const pluginId = pkg.openblock?.extensionId || pkg.openblock?.deviceId;
        if (!pluginId) {
            return {updated: false, reason: 'No plugin ID'};
        }
        
        // 2. Get translations file path
        const translationsField = pkg.openblock?.translations;
        if (!translationsField) {
            return {updated: false, reason: 'No translations field'};
        }
        const translationsPath = translationsField.replace(/^\.\//, '');
        
        // 3. Get current translations
        let currentTranslations = {};
        try {
            const currentContent = await fetchRawFile(owner, repo, 'HEAD', translationsPath);
            currentTranslations = parseTranslationsJs(currentContent);
        } catch (err) {
            logger.warn(`  Could not fetch current translations: ${err.message}`);
        }
        
        // 4. Get Transifex translations for this plugin
        const incomingTranslations = pluginTranslations[pluginId];
        if (!incomingTranslations) {
            return {updated: false, reason: 'No translations in Transifex'};
        }
        
        // 5. Compare differences
        const diff = compareTranslations(currentTranslations, incomingTranslations);
        
        if (!diff.hasChanges) {
            return {updated: false, reason: 'No changes'};
        }
        
        logger.info(`  Found ${diff.changes.total} changes (${diff.changes.added.length} added, ${diff.changes.updated.length} updated)`);
        
        if (dryRun) {
            return {updated: true, dryRun: true};
        }
        
        // 6. Merge translations and generate new file
        const mergedTranslations = mergeTranslations(currentTranslations, incomingTranslations);
        const newContent = generateTranslationsJs(mergedTranslations);
        
        // 7. Create PR
        const pr = await createTranslationPR({
            owner,
repo,
translationsPath,
newContent,
            changes: diff.changes
        });
        
        logger.success(`  Created PR #${pr.number}: ${pr.url}`);
        
        return {updated: true, pr};
        
    } catch (err) {
        logger.error(`  Failed: ${err.message}`);
        return {updated: false, error: err.message};
    }
};

/**
 * Main function
 * @param {object} options - Options
 * @param {boolean} options.dryRun - Dry run mode
 * @param {string} options.plugin - Plugin to sync
 */
const sync = async function (options = {}) {
    const {dryRun = false, plugin = null} = options;

    logger.section('OpenBlock Translation Sync');
    if (dryRun) {
        logger.warn('Running in DRY RUN mode - no PRs will be created');
    }

    // 1. Pull Transifex translations
    logger.section('Step 1: Pull translations from Transifex');
    const allTranslations = await pullAllTranslations();

    // 2. Load registry.json
    logger.section('Step 2: Load plugin registry');
    const registry = await readRegistryJson();
    const plugins = [
        ...registry.devices.map(url => ({url, type: 'devices'})),
        ...registry.extensions.map(url => ({url, type: 'extensions'}))
    ];
    logger.info(`Found ${plugins.length} plugins`);

    // 3. Extract plugin IDs
    const pluginIds = [];
    for (const {url} of plugins) {
        const {owner, repo} = parseRepoUrl(url);
        try {
            const content = await fetchRawFile(owner, repo, 'HEAD', 'package.json');
            const pkg = JSON.parse(content);
            const id = pkg.openblock?.extensionId || pkg.openblock?.deviceId;
            if (id) pluginIds.push(id);
        } catch (err) {
            logger.warn(`Could not get plugin ID for ${repo}`);
        }
    }

    // 4. Group by namespace
    logger.section('Step 3: Group translations by namespace');
    const pluginTranslations = groupByNamespace(allTranslations, pluginIds);

    // 5. Process each plugin
    logger.section('Step 4: Process plugins');
    const results = {updated: [], skipped: [], failed: []};

    for (const {url} of plugins) {
        const {owner, repo} = parseRepoUrl(url);

        if (plugin && repo !== plugin) continue;

        const result = await processPlugin({
            owner, repo, pluginTranslations, dryRun
        });

        if (result.error) {
            results.failed.push({repo, error: result.error});
        } else if (result.updated) {
            results.updated.push({repo, pr: result.pr, dryRun: result.dryRun});
        } else {
            results.skipped.push({repo, reason: result.reason});
        }
    }

    // 6. Output report
    logger.section('Summary');
    logger.info(`Updated: ${results.updated.length}`);
    results.updated.forEach(r => {
        if (r.dryRun) {
            logger.info(`  - ${r.repo} (dry run)`);
        } else {
            logger.info(`  - ${r.repo}: ${r.pr.url}`);
        }
    });

    logger.info(`Skipped: ${results.skipped.length}`);
    results.skipped.forEach(r => logger.debug(`  - ${r.repo}: ${r.reason}`));

    if (results.failed.length > 0) {
        logger.warn(`Failed: ${results.failed.length}`);
        results.failed.forEach(r => logger.error(`  - ${r.repo}: ${r.error}`));
    }
};

// Execute
const args = parseArgs();
sync({
    dryRun: args['dry-run'] || false,
    plugin: args.plugin || null
}).catch(err => {
    logger.error(`Fatal error: ${err.message}`);
    process.exit(1);
});
