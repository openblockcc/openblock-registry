/**
 * Sync toolchains - main entry point
 * Orchestrates the process of syncing toolchains between config and R2
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import logger from '../common/logger.js';
import r2Client from '../common/r2-client.js';
import {
    readLocalPackagesJson,
    writePackagesJson,
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
    packageToolchainDirect
} from './arduino/packager.js';


/**
 * Package a single Arduino toolchain for a specific platform
 * Downloads resources directly without arduino-cli, enabling cross-platform packaging
 * @param {object} item - Item to package {id, version, platform}
 * @param {object} config - Toolchains config
 * @returns {Promise<object>} Package info {url, checksum, size, archiveFileName}
 */
const packageArduinoToolchain = async (item, config) => {
    const { id, version, platform } = item;
    const workDir = path.join(os.tmpdir(), `openblock-toolchain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    try {
        await fs.mkdir(workDir, { recursive: true });

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
        const { packagesDir } = await packageToolchainDirect({
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
        const { size, checksum } = await createZipArchive(packagesDir, archivePath);

        // Upload to R2
        const remotePath = `toolchains/${archiveFileName}`;
        const { url } = await r2Client.uploadFile(archivePath, remotePath);

        return {
            url,
            checksum,
            host: platform,
            archiveFileName,
            size: String(size)
        };
    } finally {
        // Cleanup
        await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
};

/**
 * Update packages.json with new toolchains and remove deleted ones
 * @param {Array} toAdd - Items that were added
 * @param {Map<string, object>} addedSystems - Map of "id@version#platform" -> system info
 * @param {Array} toDelete - Items that were deleted
 */
const updatePackagesJsonFile = async (toAdd, addedSystems, toDelete = []) => {
    const packagesJson = await readLocalPackagesJson();
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

        let toolchain = findToolchain(toolchains, item.id, item.version);
        if (!toolchain) {
            toolchain = { id: item.id, version: item.version, systems: [] };
            toolchains.push(toolchain);
        }
        toolchain.systems.push(systemInfo);
    }

    // Sort toolchains by id, then by version (descending)
    toolchains.sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version));

    // Sort systems within each toolchain
    for (const toolchain of toolchains) {
        toolchain.systems?.sort((a, b) => a.host.localeCompare(b.host));
    }

    const updated = updateToolchains(packagesJson, toolchains);
    await writePackagesJson(updated);
};

/**
 * Main sync function
 * @param {object} options - Sync options
 * @param {boolean} options.dryRun - Only show what would be done
 * @param {string} options.platform - Only process this platform (optional)
 */
export const sync = async (options = {}) => {
    const { dryRun = false, platform = null } = options;

    logger.section('OpenBlock Toolchain Sync');

    // Read configs
    const config = await readToolchainsConfig();
    const packagesJson = await readLocalPackagesJson();
    const toolchains = getToolchains(packagesJson);

    // Fetch latest versions from Arduino package index
    logger.section('Fetching Latest Versions');
    const latestVersions = await fetchLatestVersions(config);

    // Build states and calculate diff
    const expected = buildExpectedState(config, latestVersions);
    const current = buildCurrentState(toolchains);
    let { toAdd, toDelete } = calculateDiff(expected, current);

    // Filter by platform if specified
    if (platform) {
        toAdd = toAdd.filter(item => item.platform === platform);
        toDelete = toDelete.filter(item => item.platform === platform);
    }

    logger.info(`To Add: ${toAdd.length} items`);
    logger.info(`To Delete: ${toDelete.length} items`);

    if (toAdd.length === 0 && toDelete.length === 0) {
        logger.success('Everything is up to date!');
        return { added: 0, deleted: 0 };
    }

    if (dryRun) {
        logger.section('Dry Run - No changes will be made');
        if (toAdd.length > 0) {
            logger.info('Would add:');
            toAdd.forEach(item => console.log(`  + ${item.id}@${item.version}#${item.platform}`));
        }
        if (toDelete.length > 0) {
            logger.info('Would delete:');
            toDelete.forEach(item => console.log(`  - ${item.id}@${item.version}#${item.platform}`));
        }
        return { added: 0, deleted: 0, wouldAdd: toAdd.length, wouldDelete: toDelete.length };
    }

    // Process additions first (ensure new versions are uploaded before deleting old ones)
    const addedSystems = new Map();
    const skippedPlatforms = [];
    if (toAdd.length > 0) {
        logger.section('Packaging new toolchains');
        for (const item of toAdd) {
            try {
                logger.info(`Processing: ${item.id}@${item.version}#${item.platform}`);
                const systemInfo = await packageArduinoToolchain(item, config);
                const key = `${item.id}@${item.version}#${item.platform}`;
                addedSystems.set(key, systemInfo);
            } catch (err) {
                // Check if this is a "missing tools" error - skip platform gracefully
                if (err.message.startsWith('Missing tools for')) {
                    logger.warn(`Skipping ${item.platform}: ${err.message}`);
                    skippedPlatforms.push(`${item.id}@${item.version}#${item.platform}`);
                } else {
                    logger.error(`Failed to package ${item.id}@${item.version}#${item.platform}: ${err.message}`);
                }
            }
        }
    }

    // Process deletions after new versions are successfully uploaded
    let deletedCount = 0;
    if (toDelete.length > 0) {
        logger.section('Deleting old toolchains from R2');
        for (const item of toDelete) {
            try {
                const archiveFileName = `${item.id}-${item.platform}-${item.version}.zip`;
                const remotePath = `toolchains/${archiveFileName}`;
                logger.info(`Deleting: ${archiveFileName}`);
                await r2Client.deleteFile(remotePath);
                deletedCount++;
            } catch (err) {
                logger.error(`Failed to delete ${item.id}@${item.version}#${item.platform}: ${err.message}`);
            }
        }
    }

    // Update packages.json
    if (addedSystems.size > 0 || deletedCount > 0) {
        logger.section('Updating packages.json');
        await updatePackagesJsonFile(toAdd, addedSystems, toDelete);
    }

    logger.section('Sync Complete');
    let summary = `Added: ${addedSystems.size}, Deleted: ${deletedCount}`;
    if (skippedPlatforms.length > 0) {
        summary += `, Skipped: ${skippedPlatforms.length} (missing tools)`;
    }
    logger.success(summary);

    return { added: addedSystems.size, deleted: deletedCount, skipped: skippedPlatforms.length };
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

export default { sync };

