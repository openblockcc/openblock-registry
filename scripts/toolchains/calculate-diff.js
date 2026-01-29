/**
 * Calculate diff between toolchains.json config and current packages.json
 * Automatically fetches latest versions from Arduino package index
 * Only adds new versions, never removes existing ones
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../common/logger.js';
import { readLocalPackagesJson, getToolchains } from '../common/packages-json.js';
import { OPENBLOCK_PLATFORMS } from './arduino/platform-mapper.js';
import { fetchPackageIndex, getAvailableVersions, parseCore } from './arduino/index-parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLCHAINS_JSON_PATH = path.resolve(__dirname, '../../toolchains.json');

/**
 * Read toolchains.json configuration
 * @returns {Promise<object>} Toolchains config
 */
export const readToolchainsConfig = async () => {
    const content = await fs.readFile(TOOLCHAINS_JSON_PATH, 'utf-8');
    return JSON.parse(content);
};

/**
 * Fetch all Arduino package indexes and merge them
 * @param {string[]} urls - Package index URLs
 * @returns {Promise<object>} Merged package index
 */
export const fetchAllPackageIndexes = async (urls) => {
    const mergedPackages = [];

    for (const url of urls) {
        try {
            const index = await fetchPackageIndex(url);
            if (index.packages) {
                mergedPackages.push(...index.packages);
            }
        } catch (err) {
            logger.warn(`Failed to fetch ${url}: ${err.message}`);
        }
    }

    return { packages: mergedPackages };
};

/**
 * Get latest version for each configured package from Arduino index
 * @param {object} config - Toolchains config
 * @returns {Promise<Map<string, string>>} Map of package id -> latest version
 */
export const fetchLatestVersions = async (config) => {
    const latestVersions = new Map();

    if (!config.arduino?.packages) {
        return latestVersions;
    }

    // Fetch all package indexes
    const urls = config.arduino.board_manager?.additional_urls ?? [];
    const packageIndex = await fetchAllPackageIndexes(urls);

    // Get latest version for each package
    for (const pkg of config.arduino.packages) {
        const { packager, architecture } = parseCore(pkg.core);
        const versions = getAvailableVersions(packageIndex, packager, architecture);

        if (versions.length > 0) {
            latestVersions.set(pkg.id, versions[0]); // First is latest (sorted descending)
            logger.info(`${pkg.id}: latest version is ${versions[0]}`);
        } else {
            logger.warn(`${pkg.id}: no versions found in package index`);
        }
    }

    return latestVersions;
};

/**
 * Build expected state - only the latest version for each package
 * @param {object} config - Toolchains config
 * @param {Map<string, string>} latestVersions - Map of package id -> latest version
 * @returns {Map<string, Set<string>>} Expected state (id@version -> platforms)
 */
export const buildExpectedState = (config, latestVersions) => {
    const expected = new Map();

    // Process Arduino packages
    if (config.arduino?.packages) {
        for (const pkg of config.arduino.packages) {
            const version = latestVersions.get(pkg.id);
            if (version) {
                const key = `${pkg.id}@${version}`;
                expected.set(key, new Set(OPENBLOCK_PLATFORMS));
            }
        }
    }

    return expected;
};

/**
 * Build current state from packages.json
 * Returns a Map of "id@version" -> Set of platforms
 * @param {Array} toolchains - Toolchains array from packages.json
 * @returns {Map<string, Set<string>>} Current state
 */
export const buildCurrentState = (toolchains) => {
    const current = new Map();

    for (const toolchain of toolchains) {
        const key = `${toolchain.id}@${toolchain.version}`;
        const platforms = new Set(toolchain.systems?.map(s => s.host) ?? []);
        current.set(key, platforms);
    }

    return current;
};

/**
 * Calculate diff between expected and current state
 * Adds new items and removes old versions (only keeps latest version per package)
 * @param {Map<string, Set<string>>} expected - Expected state
 * @param {Map<string, Set<string>>} current - Current state
 * @returns {{toAdd: Array, toDelete: Array}} Diff result
 */
export const calculateDiff = (expected, current) => {
    const toAdd = [];
    const toDelete = [];

    // Build a set of expected package IDs (without version) for deletion check
    const expectedIds = new Set();
    for (const key of expected.keys()) {
        const [id] = key.split('@');
        expectedIds.add(id);
    }

    // Find items to add (in expected but not in current)
    for (const [key, expectedPlatforms] of expected) {
        const [id, version] = key.split('@');
        const currentPlatforms = current.get(key) ?? new Set();

        for (const platform of expectedPlatforms) {
            if (!currentPlatforms.has(platform)) {
                toAdd.push({ id, version, platform });
            }
        }
    }

    // Find items to delete (in current but not in expected, for packages we manage)
    for (const [key, currentPlatforms] of current) {
        const [id, version] = key.split('@');

        // Only delete if this package ID is in our expected list (we manage it)
        // This prevents deleting toolchains that are not in toolchains.json
        if (!expectedIds.has(id)) {
            continue;
        }

        // If this version is not in expected, delete all its platforms
        if (!expected.has(key)) {
            for (const platform of currentPlatforms) {
                toDelete.push({ id, version, platform });
            }
        }
    }

    return { toAdd, toDelete };
};

/**
 * Main function to calculate and display diff
 */
export const main = async () => {
    logger.section('Calculating Toolchain Diff');

    // Read configs
    const config = await readToolchainsConfig();
    const packagesJson = await readLocalPackagesJson();
    const toolchains = getToolchains(packagesJson);

    // Fetch latest versions from Arduino package index
    logger.section('Fetching Latest Versions');
    const latestVersions = await fetchLatestVersions(config);

    // Build states
    const expected = buildExpectedState(config, latestVersions);
    const current = buildCurrentState(toolchains);

    logger.info(`Expected: ${expected.size} toolchain versions`);
    logger.info(`Current: ${current.size} toolchain versions in packages.json`);

    // Calculate diff
    const { toAdd, toDelete } = calculateDiff(expected, current);

    // Display results
    logger.section('Diff Results');

    if (toAdd.length > 0) {
        logger.info(`To Add (${toAdd.length}):`);
        for (const item of toAdd) {
            console.log(`  + ${item.id}@${item.version}#${item.platform}`);
        }
    }

    if (toDelete.length > 0) {
        logger.info(`To Delete (${toDelete.length}):`);
        for (const item of toDelete) {
            console.log(`  - ${item.id}@${item.version}#${item.platform}`);
        }
    }

    if (toAdd.length === 0 && toDelete.length === 0) {
        logger.success('Everything is up to date!');
    }

    return { toAdd, toDelete, latestVersions, config };
};

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(err => {
        logger.error(err.message);
        process.exit(1);
    });
}

export default {
    readToolchainsConfig,
    fetchLatestVersions,
    buildExpectedState,
    buildCurrentState,
    calculateDiff,
    main
};
