/**
 * Sync toolchains - main entry point
 * Orchestrates the process of syncing toolchains between config and R2
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {fileURLToPath} from 'url';
import logger from '../common/logger.js';
import r2Client from '../common/r2-client.js';
import {
    fetchRemotePackagesJson,
    getToolchains,
    updateToolchains,
    findToolchain
} from '../common/packages-json.js';
import {
    readToolchainsConfig,
    fetchLatestVersions,
    buildExpectedState,
    buildCurrentState,
    calculateDiff
} from './calculate-diff.js';
import {
    createZipArchive,
    packageToolchainDirect,
    MissingToolsError,
    mergePackageIndexes
} from './arduino/packager.js';
import {OPENBLOCK_PLATFORMS} from './arduino/platform-mapper.js';
import {collectDownloadResources, parseCore} from './arduino/index-parser.js';


/**
 * Package a single Arduino toolchain for a specific platform
 * Downloads resources directly without arduino-cli, enabling cross-platform packaging
 * @param {object} item - Item to package {id, version, platform}
 * @param {object} config - Toolchains config
 * @returns {Promise<object>} Package info {url, checksum, size, archiveFileName, fallbackUsed}
 */
const packageArduinoToolchain = async (item, config) => {
    const {id, version, platform} = item;
    const randomSuffix = Math.random().toString(36)
.slice(2, 8);
    const workDir = path.join(os.tmpdir(), `openblock-toolchain-${Date.now()}-${randomSuffix}`);

    try {
        await fs.mkdir(workDir, {recursive: true});

        // Find package config
        const pkgConfig = config.arduino.packages.find(p => p.id === id);
        if (!pkgConfig) {
            throw new Error(`Package config not found for: ${id}`);
        }

        // Get index URLs from config
        const indexUrls = config.arduino.board_manager?.additional_urls ?? [];
        // Always include the main Arduino package index
        if (!indexUrls.includes('https://downloads.arduino.cc/packages/package_index.json')) {
            indexUrls.unshift('https://downloads.arduino.cc/packages/package_index.json');
        }

        // Package using direct download (no arduino-cli needed)
        const {packagesDir, fallbackUsed} = await packageToolchainDirect({
            core: pkgConfig.core,
            version,
            platform,
            indexUrls,
            workDir
        });

        // Create archive
        const archiveFileName = `${id}-${platform}-${version}.zip`;
        const archivePath = path.join(workDir, archiveFileName);
        logger.info(`Creating archive: ${archiveFileName}`);
        const {size, checksum} = await createZipArchive(packagesDir, archivePath);

        // Upload to R2
        const remotePath = `toolchains/${archiveFileName}`;
        const {url} = await r2Client.uploadFile(archivePath, remotePath);

        return {
            url,
            checksum,
            host: platform,
            archiveFileName,
            size: String(size),
            fallbackUsed
        };
    } finally {
        // Cleanup
        await fs.rm(workDir, {recursive: true, force: true}).catch(() => {});
    }
};

/**
 * Update packages.json with new toolchains and remove deleted ones
 * Fetches current state from R2, updates it, and uploads back to R2
 * @param {Array} toAdd - Items that were added
 * @param {Map<string, object>} addedSystems - Map of "id@version#platform" -> system info
 * @param {Array} toDelete - Items that were deleted
 * @returns {Promise<object>} Updated packages.json
 */
const updatePackagesJsonFile = async (toAdd, addedSystems, toDelete = []) => {
    const packagesJson = await fetchRemotePackagesJson();
    let toolchains = getToolchains(packagesJson);

    // Remove deleted items first
    for (const item of toDelete) {
        const toolchain = findToolchain(toolchains, item.id, item.version);
        if (toolchain && toolchain.systems) {
            toolchain.systems = toolchain.systems.filter(s => s.host !== item.platform);
        }
    }

    // Remove toolchains with no systems left
    toolchains = toolchains.filter(t => t.systems && t.systems.length > 0);

    // Add new items
    for (const item of toAdd) {
        const key = `${item.id}@${item.version}#${item.platform}`;
        const systemInfo = addedSystems.get(key);
        if (!systemInfo) continue;

        // Remove fallbackUsed property before saving to packages.json
        const {fallbackUsed: _fallbackUsed, ...systemInfoClean} = systemInfo;

        let toolchain = findToolchain(toolchains, item.id, item.version);
        if (!toolchain) {
            toolchain = {id: item.id, version: item.version, systems: []};
            toolchains.push(toolchain);
        }
        toolchain.systems.push(systemInfoClean);
    }

    // Sort toolchains by id, then by version (descending)
    toolchains.sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version));

    // Sort systems within each toolchain
    for (const toolchain of toolchains) {
        if (toolchain.systems) {
            toolchain.systems.sort((a, b) => a.host.localeCompare(b.host));
        }
    }

    const updated = updateToolchains(packagesJson, toolchains);

    // Upload packages.json directly to R2
    await r2Client.uploadJson(updated, 'packages.json');
    logger.success('Updated packages.json in R2');

    return updated;
};

/**
 * Format file size for display
 * @param {number|string} bytes - Size in bytes
 * @returns {string} Formatted size
 */
const formatSize = (bytes) => {
    const size = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

/**
 * Generate markdown sync report
 * @param {object} reportData - Report data
 * @returns {string} Markdown report
 */
const generateSyncReport = (reportData) => {
    const {currentState, added, deleted, skipped, summary, dryRun} = reportData;
    const lines = [];

    lines.push('## Toolchain Sync Report');
    lines.push('');

    if (dryRun) {
        lines.push('> **Dry Run** - No changes were made');
        lines.push('');
    }

    // Summary
    lines.push('### Summary');
    if (dryRun) {
        lines.push('| To Add | To Skip | To Delete |');
        lines.push('|:------:|:-------:|:---------:|');
        lines.push(`| ${summary.added} | ${summary.skipped} | ${summary.deleted} |`);
    } else {
        lines.push('| Added | Skipped | Deleted | Failed |');
        lines.push('|:-----:|:-------:|:-------:|:------:|');
        lines.push(`| ${summary.added} | ${summary.skipped} | ${summary.deleted} | ${summary.failed} |`);
    }
    lines.push('');

    // Current State
    if (currentState.size > 0) {
        lines.push('### Current State');
        lines.push('');
        lines.push(`| Toolchain | Version | ${OPENBLOCK_PLATFORMS.join(' | ')} |`);
        lines.push(`|-----------|---------|${OPENBLOCK_PLATFORMS.map(() => ':---:').join('|')}|`);

        // Sort by id, then version
        const sortedEntries = [...currentState.entries()].sort((a, b) => {
            const [idA, versionA] = a[0].split('@');
            const [idB, versionB] = b[0].split('@');
            return idA.localeCompare(idB) || versionB.localeCompare(versionA);
        });

        for (const [key, platforms] of sortedEntries) {
            const [id, version] = key.split('@');
            const cells = OPENBLOCK_PLATFORMS.map(platform => platforms.has(platform) ? '✓' : '');
            lines.push(`| ${id} | ${version} | ${cells.join(' | ')} |`);
        }
        lines.push('');
    }

    // Changes section
    const hasChanges = added.length > 0 || deleted.length > 0 || skipped.length > 0;
    if (hasChanges) {
        lines.push('### Changes');
        lines.push('');
    }

    // Added
    if (added.length > 0) {
        lines.push('#### Added');
        lines.push('');
        lines.push('| Toolchain | Version | Platform | Size | Note |');
        lines.push('|-----------|---------|----------|-----:|------|');
        for (const item of added) {
            const note = item.fallbackUsed ? `fallback: ${item.fallbackUsed}` : '';
            lines.push(`| ${item.id} | ${item.version} | ${item.platform} | ${formatSize(item.size)} | ${note} |`);
        }
        lines.push('');
    }

    // Deleted
    if (deleted.length > 0) {
        lines.push('#### Deleted');
        lines.push('');
        lines.push('| Toolchain | Version | Platform |');
        lines.push('|-----------|---------|----------|');
        for (const item of deleted) {
            lines.push(`| ${item.id} | ${item.version} | ${item.platform} |`);
        }
        lines.push('');
    }

    // Skipped (missing tools)
    if (skipped.length > 0) {
        lines.push('#### Skipped (Missing Tools)');
        lines.push('');
        lines.push('| Toolchain | Version | Platform | Missing Tools |');
        lines.push('|-----------|---------|----------|---------------|');
        for (const item of skipped) {
            const tools = item.missingTools?.map(t => `${t.packager}/${t.name}@${t.version}`).join(', ') || '';
            lines.push(`| ${item.id} | ${item.version} | ${item.platform} | ${tools} |`);
        }
        lines.push('');
    }

    return lines.join('\n');
};

/**
 * Main sync function
 * @param {object} options - Sync options
 * @param {boolean} options.dryRun - Only show what would be done
 * @param {string} options.platform - Only process this platform (optional)
 */
export const sync = async (options = {}) => {
    const {dryRun = false, platform = null} = options;

    logger.section('OpenBlock Toolchain Sync');

    // Read configs
    const config = await readToolchainsConfig();

    // Fetch current packages.json from R2
    logger.info('Fetching current packages.json from R2...');
    const packagesJson = await fetchRemotePackagesJson();
    const toolchains = getToolchains(packagesJson);

    // Fetch latest versions from Arduino package index
    logger.section('Fetching Latest Versions');
    const latestVersions = await fetchLatestVersions(config);

    // Build states and calculate diff
    const expected = buildExpectedState(config, latestVersions);
    const current = buildCurrentState(toolchains);
    let {toAdd, toDelete} = calculateDiff(expected, current);

    // Filter by platform if specified
    if (platform) {
        toAdd = toAdd.filter(item => item.platform === platform);
        toDelete = toDelete.filter(item => item.platform === platform);
    }

    logger.info(`To Add: ${toAdd.length} items`);
    logger.info(`To Delete: ${toDelete.length} items`);

    // Initialize report data
    const addedItems = [];
    const deletedItems = [];
    const skippedItems = [];
    let failedCount = 0;

    if (toAdd.length === 0 && toDelete.length === 0) {
        logger.success('Everything is up to date!');
        const report = generateSyncReport({
            currentState: current,
            added: [],
            deleted: [],
            skipped: [],
            summary: {added: 0, skipped: 0, deleted: 0, failed: 0},
            dryRun: false
        });
        console.log('\n' + report);
        return {added: 0, deleted: 0, report};
    }

    if (dryRun) {
        logger.section('Dry Run - No changes will be made');

        // Check availability for items to add
        logger.info('Checking tool availability for new items...');
        const indexUrls = config.arduino.board_manager?.additional_urls ?? [];
        const packageIndex = await mergePackageIndexes(indexUrls);

        for (const item of toAdd) {
            const pkgConfig = config.arduino.packages.find(p => p.id === item.id);
            if (!pkgConfig) {
                skippedItems.push({...item, missingTools: []});
                continue;
            }

            const {packager, architecture} = parseCore(pkgConfig.core);
            const resources = collectDownloadResources(packageIndex, packager, architecture, item.version, item.platform);

            if (resources.missingTools.length > 0) {
                skippedItems.push({...item, missingTools: resources.missingTools});
            } else {
                addedItems.push({
                    ...item,
                    size: 0, // Size unknown in dry run
                    fallbackUsed: resources.fallbackUsed
                });
            }
        }

        // Mark items to delete
        for (const item of toDelete) {
            deletedItems.push(item);
        }

        const report = generateSyncReport({
            currentState: current,
            added: addedItems,
            deleted: deletedItems,
            skipped: skippedItems,
            summary: {added: addedItems.length, skipped: skippedItems.length, deleted: deletedItems.length, failed: 0},
            dryRun: true
        });
        console.log('\n' + report);
        return {added: 0, deleted: 0, wouldAdd: addedItems.length, wouldDelete: deletedItems.length, report};
    }

    // Process additions first (ensure new versions are uploaded before deleting old ones)
    const addedSystems = new Map();
    if (toAdd.length > 0) {
        logger.section('Packaging new toolchains');
        for (const item of toAdd) {
            try {
                logger.info(`Processing: ${item.id}@${item.version}#${item.platform}`);
                const systemInfo = await packageArduinoToolchain(item, config);
                const key = `${item.id}@${item.version}#${item.platform}`;
                addedSystems.set(key, systemInfo);

                addedItems.push({
                    ...item,
                    size: systemInfo.size,
                    fallbackUsed: systemInfo.fallbackUsed
                });
            } catch (err) {
                // Check if this is a MissingToolsError
                if (err instanceof MissingToolsError) {
                    logger.warn(`Skipping ${item.platform}: ${err.message}`);
                    skippedItems.push({...item, missingTools: err.missingTools});
                } else {
                    logger.error(`Failed to package ${item.id}@${item.version}#${item.platform}: ${err.message}`);
                    failedCount++;
                }
            }
        }
    }

    // Process deletions after new versions are successfully uploaded
    if (toDelete.length > 0) {
        logger.section('Deleting old toolchains from R2');
        for (const item of toDelete) {
            try {
                const archiveFileName = `${item.id}-${item.platform}-${item.version}.zip`;
                const remotePath = `toolchains/${archiveFileName}`;
                logger.info(`Deleting: ${archiveFileName}`);
                await r2Client.deleteFile(remotePath);
                deletedItems.push(item);
            } catch (err) {
                logger.error(`Failed to delete ${item.id}@${item.version}#${item.platform}: ${err.message}`);
            }
        }
    }

    // Update packages.json in R2
    let updatedCurrentState = current;
    if (addedSystems.size > 0 || deletedItems.length > 0) {
        logger.section('Updating packages.json in R2');
        const updatedPackagesJson = await updatePackagesJsonFile(toAdd, addedSystems, toDelete);
        const updatedToolchains = getToolchains(updatedPackagesJson);
        updatedCurrentState = buildCurrentState(updatedToolchains);
    }

    // Generate report
    const report = generateSyncReport({
        currentState: updatedCurrentState,
        added: addedItems,
        deleted: deletedItems,
        skipped: skippedItems,
        summary: {
            added: addedItems.length,
            skipped: skippedItems.length,
            deleted: deletedItems.length,
            failed: failedCount
        },
        dryRun: false
    });

    logger.section('Sync Complete');
    console.log('\n' + report);

    return {added: addedItems.length, deleted: deletedItems.length, skipped: skippedItems.length, failed: failedCount, report};
};

/**
 * Parse command line arguments
 * @returns {object} Parsed options
 */
const parseArgs = () => {
    const args = process.argv.slice(2);
    const options = {
        dryRun: args.includes('--dry-run'),
        platform: null
    };

    const platformIndex = args.indexOf('--platform');
    if (platformIndex !== -1 && args[platformIndex + 1]) {
        options.platform = args[platformIndex + 1];
    }

    return options;
};

// Run if executed directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    const options = parseArgs();
    sync(options).catch(err => {
        logger.error(err.message);
        console.error(err.stack);
        process.exit(1);
    });
}

export default {sync};
