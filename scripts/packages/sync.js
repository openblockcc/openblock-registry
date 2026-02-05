#!/usr/bin/env node

/**
 * Main sync script for OpenBlock Registry packages
 * Syncs devices and extensions from registry.json to R2 storage
 */

import {fileURLToPath} from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import logger from '../common/logger.js';
import {readRegistryJson, parseRepoUrl, isValidSemver, calculateDiff, getPackageVersions} from './calculate-diff.js';
import {fetchTags, fetchPackageJson, createIssue} from './github/api.js';
import {createZipArchive} from './github/downloader.js';
import {processVersion} from './plugin-processor.js';
import {
    fetchTranslationsFromR2,
    uploadTranslationsToR2,
    initTranslationsDir,
    mergePluginTranslations,
    pushToTransifex
} from './translation-merger.js';
import {uploadFile, uploadJson} from '../common/r2-client.js';
import {
    fetchRemotePackagesJson,
    getDevices,
    getExtensions,
    addPackageVersion
} from '../common/packages-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const DEFAULT_CONCURRENCY = 3;
const TEMP_DIR_PREFIX = 'openblock-sync-';
const GLOBAL_TRANSLATIONS_DIR = path.resolve(__dirname, '../../.translations');

/**
 * Run tasks with concurrency limit
 * @param {Array} items - Items to process
 * @param {Function} handler - Handler function for each item
 * @param {number} concurrency - Max concurrent tasks
 * @returns {Promise<Array>} Results array
 */
const runWithConcurrency = async (items, handler, concurrency) => {
    const results = [];
    const executing = [];

    for (const item of items) {
        const promise = handler(item).then(result => {
            executing.splice(executing.indexOf(promise), 1);
            return result;
        });

        results.push(promise);
        executing.push(promise);

        if (executing.length >= concurrency) {
            await Promise.race(executing);
        }
    }

    return Promise.all(results);
};

/**
 * Build package entry for packages.json
 * Uses the compiled dist/package.json which contains base64 iconURL and processed fields
 * @param {object} distPackageJson - Compiled package.json from dist directory
 * @param {string} type - Package type ('devices' or 'extensions')
 * @param {string} version - Version string
 * @param {string} repoUrl - Repository URL
 * @param {object} fileInfo - File information (url, checksum, size)
 * @returns {object} Package entry for packages.json
 */
const buildPackageEntry = (distPackageJson, type, version, repoUrl, fileInfo) => {
    const openblock = distPackageJson.openblock || {};
    const idField = type === 'devices' ? 'deviceId' : 'extensionId';
    const id = openblock[idField];

    // Start with the id and version
    const entry = {
        [idField]: id,
        version
    };

    // Copy all openblock fields directly from dist/package.json
    // This includes base64 iconURL, i18n formatted name/description, etc.
    const openblockFields = [
        'name',
        'description',
        'iconURL',
        'helpLink',
        'tags',
        'l10n'
    ];

    // Device-specific fields
    const deviceFields = [
        'manufactor',
        'learnMore',
        'type',
        'programMode',
        'programLanguage',
        'extensions',
        'extensionsCompatible',
        'bluetoothRequired',
        'serialportRequired',
        'internetConnectionRequired'
    ];

    // Extension-specific fields
    const extensionFields = [
        'supportDevice'
    ];

    // Copy common fields
    for (const field of openblockFields) {
        if (Object.prototype.hasOwnProperty.call(openblock, field)) {
            entry[field] = openblock[field];
        }
    }

    // Copy type-specific fields
    const typeFields = type === 'devices' ? deviceFields : extensionFields;
    for (const field of typeFields) {
        if (Object.prototype.hasOwnProperty.call(openblock, field)) {
            entry[field] = openblock[field];
        }
    }

    // Add author from package.json root
    if (distPackageJson.author) {
        entry.author = distPackageJson.author;
    }

    // Add repository URL
    entry.repository = repoUrl;

    // Add file information
    entry.url = fileInfo.url;
    entry.archiveFileName = fileInfo.archiveFileName;
    entry.checksum = `SHA-256:${fileInfo.checksum}`;
    entry.size = fileInfo.size.toString();

    return entry;
};

/**
 * Process a single repository
 * @param {string} type - Package type (devices/extensions)
 * @param {string} repoUrl - Repository URL
 * @param {object} currentPackages - Current packages.json
 * @param {string} tempDir - Temporary directory
 * @param {object} options - Processing options
 * @param {object} globalTranslations - Global translations from R2 (mutated in place)
 * @returns {Promise<object>} Processing result with added, skipped, errors, and currentPackages properties
 */
const processRepository = async (type, repoUrl, currentPackages, tempDir, options, globalTranslations) => {
    const {owner, repo} = parseRepoUrl(repoUrl);
    const added = [];
    const skipped = [];
    const errors = [];

    logger.info(`Processing ${type}: ${owner}/${repo}`);

    try {
        // Fetch tags from GitHub
        const tags = await fetchTags(owner, repo);
        const validTags = tags.filter(tag => isValidSemver(tag.name));

        if (validTags.length === 0) {
            logger.warn(`No valid semantic version tags found in ${owner}/${repo}`);
            return {added, skipped, errors, currentPackages};
        }

        logger.info(`Found ${validTags.length} valid version(s) in ${owner}/${repo}`);

        // Get existing versions from packages.json
        // We need to fetch package.json from the first tag to get the ID
        const firstTag = validTags[0].name;
        const firstPackageJson = await fetchPackageJson(owner, repo, firstTag);
        const id = type === 'devices' ?
            firstPackageJson.openblock?.deviceId :
            firstPackageJson.openblock?.extensionId;

        if (!id) {
            const error = `Missing ${type === 'devices' ? 'deviceId' : 'extensionId'} in package.json`;
            errors.push({repo: `${owner}/${repo}`, version: firstTag, error});
            return {added, skipped, errors, currentPackages};
        }

        const currentVersions = getPackageVersions(
            type === 'devices' ? getDevices(currentPackages) : getExtensions(currentPackages),
            id
        );

        // Calculate diff
        const {toAdd, toSkip} = calculateDiff(validTags, currentVersions);

        logger.info(`${owner}/${repo}: ${toAdd.length} to add, ${toSkip.length} to skip`);

        // Skip versions
        skipped.push(...toSkip.map(v => ({
            type,
            id,
            repo: `${owner}/${repo}`,
            version: v
        })));

        // Process versions to add
        for (const version of toAdd) {
            try {
                if (options.dryRun) {
                    logger.info(`[DRY RUN] Would process ${owner}/${repo}@${version}`);
                    added.push({
                        type,
                        id,
                        repo: `${owner}/${repo}`,
                        version,
                        dryRun: true
                    });
                    continue;
                }

                logger.info(`Processing version ${owner}/${repo}@${version}...`);

                // Process the version (download, validate, build, extract translations)
                const processResult = await processVersion({
                    owner,
                    repo,
                    tag: version,
                    type,
                    tempDir
                });

                if (!processResult.success) {
                    errors.push({
                        type,
                        repo: `${owner}/${repo}`,
                        version,
                        error: processResult.error
                    });
                    continue;
                }

                const {distPath, translationsPath, cleanup} = processResult.data;

                try {
                    // Read package.json from dist directory (contains base64 iconURL and processed fields)
                    const distPackageJsonPath = path.join(distPath, 'package.json');
                    const distPackageJson = JSON.parse(await fs.readFile(distPackageJsonPath, 'utf-8'));

                    // Create zip from dist directory
                    const archiveFileName = `${id}-${version}.zip`;
                    const zipPath = path.join(tempDir, archiveFileName);
                    const zipResult = await createZipArchive(distPath, zipPath);

                    // Upload to R2
                    const remotePath = `${type}/${id}/${version}.zip`;
                    const uploadResult = await uploadFile(zipPath, remotePath);

                    // Merge translations if available (using R2-based workflow)
                    if (translationsPath && globalTranslations) {
                        await mergePluginTranslations(translationsPath, globalTranslations, id);
                    }

                    // Build package entry using dist/package.json
                    const packageEntry = buildPackageEntry(distPackageJson, type, version, repoUrl, {
                        url: uploadResult.url,
                        archiveFileName,
                        checksum: zipResult.checksum,
                        size: zipResult.size
                    });

                    // Add to current packages
                    currentPackages = addPackageVersion(currentPackages, type, packageEntry);

                    added.push({
                        type,
                        id,
                        repo: `${owner}/${repo}`,
                        version,
                        size: zipResult.size,
                        url: uploadResult.url
                    });

                    logger.success(`Successfully processed ${owner}/${repo}@${version}`);

                    // Cleanup
                    await cleanup();
                    await fs.unlink(zipPath).catch(() => {});

                } catch (err) {
                    await processResult.data.cleanup();
                    throw err;
                }

            } catch (err) {
                logger.error(`Failed to process ${owner}/${repo}@${version}: ${err.message}`);
                errors.push({
                    type,
                    repo: `${owner}/${repo}`,
                    version,
                    error: err.message
                });
            }
        }

        return {added, skipped, errors, currentPackages};

    } catch (err) {
        logger.error(`Failed to process ${owner}/${repo}: ${err.message}`);
        errors.push({repo: `${owner}/${repo}`, version: 'N/A', error: err.message});
        return {added, skipped, errors, currentPackages};
    }
};

/**
 * Generate sync report in Markdown format
 * @param {object} results - Sync results
 * @returns {string} Markdown report
 */
const generateReport = (results) => {
    const {added, skipped, errors, repositoryStats, dryRun} = results;

    let report = '## Package Sync Report\n\n';

    if (dryRun) {
        report += '> **Dry Run** - No changes were made\n\n';
    }

    // Summary
    report += '### Summary\n\n';
    report += '| Added | Skipped | Failed |\n';
    report += '|:-----:|:-------:|:------:|\n';
    report += `| ${added.length} | ${skipped.length} | ${errors.length} |\n\n`;

    // Added
    if (added.length > 0) {
        report += '### Added\n\n';
        report += '| Type | ID | Version | Size | Repository |\n';
        report += '|------|-----|---------|-----:|------------|\n';
        added.forEach(item => {
            const sizeKB = (item.size / 1024).toFixed(1);
            const typeLabel = item.type === 'devices' ? 'device' : 'extension';
            report += `| ${typeLabel} | ${item.id} | ${item.version} | ${sizeKB} KB | ${item.repo} |\n`;
        });
        report += '\n';
    }

    // Skipped
    if (skipped.length > 0) {
        report += '### Skipped (Already Exists)\n\n';
        report += '| Type | ID | Version |\n';
        report += '|------|-----|---------|\n';
        skipped.forEach(item => {
            const typeLabel = item.type === 'devices' ? 'device' : 'extension';
            report += `| ${typeLabel} | ${item.id} | ${item.version} |\n`;
        });
        report += '\n';
    }

    // Errors
    if (errors.length > 0) {
        report += '### Failed\n\n';
        report += '| Type | Repository | Version | Error |\n';
        report += '|------|------------|---------|-------|\n';
        errors.forEach(item => {
            const typeLabel = item.type === 'devices' ? 'device' : 'extension';
            report += `| ${typeLabel} | ${item.repo} | ${item.version} | ${item.error} |\n`;
        });
        report += '\n';
    }

    // Repository Status
    if (repositoryStats && repositoryStats.length > 0) {
        report += '### Repository Status\n\n';
        report += '| Repository | Tags Found | Added | Skipped | Failed |\n';
        report += '|------------|:----------:|:-----:|:-------:|:------:|\n';
        repositoryStats.forEach(stat => {
            report += `| ${stat.repo} | ${stat.tagsFound} | ${stat.added} | ${stat.skipped} | ${stat.failed} |\n`;
        });
        report += '\n';
    }

    return report;
};

/**
 * Create issues for failed syncs
 * @param {Array} errors - Error list
 * @param {string} workflowRunUrl - GitHub workflow run URL
 */
const createErrorIssues = async (errors, workflowRunUrl) => {
    logger.section('Creating Issues for Errors');

    for (const error of errors) {
        try {
            const {owner, repo} = parseRepoUrl(`https://github.com/${error.repo}`);

            const title = `[OpenBlock Registry] Sync failed for version ${error.version}`;
            const body = `## ❌ OpenBlock Registry Sync Failed

The automatic sync process encountered an error while processing this repository.

### Error Details

| Field | Value |
|-------|-------|
| **Version** | ${error.version} |
| **Error** | ${error.error} |
| **Timestamp** | ${new Date().toISOString()} |

### Workflow Run

🔗 [View workflow run](${workflowRunUrl || 'N/A'})

### Next Steps

Please check the error message above and verify your repository configuration. If you believe this is a bug in the sync process, please report it at:
https://github.com/openblockcc/openblock-registry/issues

---
*This issue was automatically created by OpenBlock Registry sync workflow.*`;

            await createIssue(owner, repo, title, body);
            logger.success(`Created issue in ${owner}/${repo}`);

        } catch (err) {
            logger.warn(`Failed to create issue for ${error.repo}: ${err.message}`);
        }
    }
};

/**
 * Main sync function
 * @param {object} options - Sync options
 * @param {boolean} options.dryRun - Dry run mode
 * @param {number} options.concurrency - Concurrency limit
 * @param {boolean} options.skipTransifex - Skip Transifex push
 */
export const sync = async (options = {}) => {
    const {
        dryRun = false,
        skipTransifex = false
    } = options;

    logger.section('OpenBlock Registry Package Sync');

    if (dryRun) {
        logger.warn('DRY RUN MODE - No changes will be made');
    }

    const allAdded = [];
    const allSkipped = [];
    const allErrors = [];
    const repositoryStats = [];

    try {
        // Create temp directory
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
        logger.info(`Temporary directory: ${tempDir}`);

        try {
            // Read registry.json
            logger.section('Reading Configuration');
            const registry = await readRegistryJson();
            logger.info(`Devices: ${registry.devices.length}`);
            logger.info(`Extensions: ${registry.extensions.length}`);

            // Fetch current packages.json from R2
            logger.section('Fetching Current Packages');
            let currentPackages = await fetchRemotePackagesJson();
            logger.info(`Current devices: ${getDevices(currentPackages).length}`);
            logger.info(`Current extensions: ${getExtensions(currentPackages).length}`);

            // Fetch existing translations from R2
            let globalTranslations = null;
            if (!dryRun) {
                globalTranslations = await fetchTranslationsFromR2();
            }

            // Process devices
            logger.section('Processing Devices');
            for (const repoUrl of registry.devices) {
                const result = await processRepository('devices', repoUrl, currentPackages, tempDir, options, globalTranslations);
                allAdded.push(...result.added);
                allSkipped.push(...result.skipped);
                allErrors.push(...result.errors);
                currentPackages = result.currentPackages || currentPackages;

                // Collect repository stats
                const {owner, repo} = parseRepoUrl(repoUrl);
                const repoName = `${owner}/${repo}`;
                const tagsFound = result.added.length + result.skipped.length + result.errors.length;
                repositoryStats.push({
                    repo: repoName,
                    tagsFound,
                    added: result.added.length,
                    skipped: result.skipped.length,
                    failed: result.errors.length
                });
            }

            // Process extensions
            logger.section('Processing Extensions');
            for (const repoUrl of registry.extensions) {
                const result = await processRepository('extensions', repoUrl, currentPackages, tempDir, options, globalTranslations);
                allAdded.push(...result.added);
                allSkipped.push(...result.skipped);
                allErrors.push(...result.errors);
                currentPackages = result.currentPackages || currentPackages;

                // Collect repository stats
                const {owner, repo} = parseRepoUrl(repoUrl);
                const repoName = `${owner}/${repo}`;
                const tagsFound = result.added.length + result.skipped.length + result.errors.length;
                repositoryStats.push({
                    repo: repoName,
                    tagsFound,
                    added: result.added.length,
                    skipped: result.skipped.length,
                    failed: result.errors.length
                });
            }

            // Upload updated packages.json
            if (!dryRun && allAdded.length > 0) {
                logger.section('Uploading packages.json');
                await uploadJson(currentPackages, 'packages.json');
                logger.success('packages.json updated');
            }

            // Upload translations to R2 and push to Transifex
            if (!dryRun && !skipTransifex && allAdded.length > 0 && globalTranslations) {
                logger.section('Syncing Translations');

                // 1. Upload updated translations to R2
                await uploadTranslationsToR2(globalTranslations);

                // 2. Initialize local .translations directory with R2 data for Transifex push
                await initTranslationsDir(GLOBAL_TRANSLATIONS_DIR, globalTranslations);

                // 3. Push to Transifex
                logger.info('Pushing translations to Transifex...');
                const repoRoot = path.resolve(__dirname, '../..');
                const pushResult = await pushToTransifex(repoRoot);

                // If push fails, throw error to stop the workflow
                if (!pushResult.success) {
                    throw new Error(`Failed to push translations to Transifex: ${pushResult.error}`);
                }
            }

            // Create issues for errors
            if (!dryRun && allErrors.length > 0) {
                const workflowRunUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ?
                    `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` :
                    null;
                await createErrorIssues(allErrors, workflowRunUrl);
            }

        } finally {
            // Cleanup temp directory
            await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
        }

        // Generate and display report
        const report = generateReport({
            added: allAdded,
            skipped: allSkipped,
            errors: allErrors,
            repositoryStats,
            dryRun
        });
        console.log(report);

        // Log errors but don't fail the workflow for third-party plugin errors
        // Third-party plugins are untrusted and their errors should not break the registry workflow
        if (allErrors.length > 0) {
            logger.warn(`Sync completed with ${allErrors.length} error(s) in third-party plugins`);
        }

        logger.success('Sync completed successfully!');

    } catch (err) {
        logger.error(`Sync failed: ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    }
};

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const options = {
        dryRun: args.includes('--dry-run'),
        skipTransifex: args.includes('--skip-transifex'),
        concurrency: DEFAULT_CONCURRENCY
    };

    // Parse concurrency
    const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='));
    if (concurrencyArg) {
        options.concurrency = parseInt(concurrencyArg.split('=')[1], 10) || DEFAULT_CONCURRENCY;
    }

    sync(options).catch(err => {
        logger.error(err.message);
        process.exit(1);
    });
}

export default {
    sync,
    runWithConcurrency,
    buildPackageEntry,
    processRepository,
    generateReport
};
