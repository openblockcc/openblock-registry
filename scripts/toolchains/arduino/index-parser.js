/**
 * Arduino package index parser
 * Fetches and parses Arduino board manager package_index.json files
 */

import logger from '../../common/logger.js';
import { toOpenBlockPlatform, OPENBLOCK_PLATFORMS } from './platform-mapper.js';

/**
 * Fetch and parse Arduino package index from URL
 * @param {string} url - Package index URL
 * @returns {Promise<object>} Parsed package index
 */
export const fetchPackageIndex = async (url) => {
    try {
        logger.debug(`Fetching package index: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (err) {
        logger.error(`Failed to fetch package index from ${url}: ${err.message}`);
        throw err;
    }
};

/**
 * Find a platform (core) in package index
 * @param {object} packageIndex - Arduino package index
 * @param {string} packager - Packager name (e.g., 'arduino', 'esp32')
 * @param {string} architecture - Architecture name (e.g., 'avr', 'esp32')
 * @param {string} version - Version string
 * @returns {object|null} Platform object or null if not found
 */
export const findPlatform = (packageIndex, packager, architecture, version) => {
    const pkg = packageIndex.packages?.find(p => p.name.toLowerCase() === packager.toLowerCase());
    if (!pkg) {
        logger.warn(`Packager not found: ${packager}`);
        return null;
    }

    const platform = pkg.platforms?.find(p =>
        p.architecture.toLowerCase() === architecture.toLowerCase() &&
        p.version === version
    );

    if (!platform) {
        logger.warn(`Platform not found: ${packager}:${architecture}@${version}`);
        return null;
    }

    return platform;
};

/**
 * Get all available versions for a platform
 * @param {object} packageIndex - Arduino package index
 * @param {string} packager - Packager name
 * @param {string} architecture - Architecture name
 * @returns {string[]} Array of version strings, sorted descending
 */
export const getAvailableVersions = (packageIndex, packager, architecture) => {
    const pkg = packageIndex.packages?.find(p => p.name.toLowerCase() === packager.toLowerCase());
    if (!pkg) return [];

    return pkg.platforms
        ?.filter(p => p.architecture.toLowerCase() === architecture.toLowerCase())
        ?.map(p => p.version)
        ?.sort((a, b) => compareVersions(b, a)) ?? [];
};

/**
 * Get tool dependencies for a platform
 * @param {object} platform - Platform object from package index
 * @returns {Array} Array of tool dependencies
 */
export const getToolDependencies = (platform) => {
    return platform.toolsDependencies ?? [];
};

/**
 * Find a tool in package index
 * @param {object} packageIndex - Arduino package index
 * @param {string} packager - Packager name
 * @param {string} toolName - Tool name
 * @param {string} version - Tool version
 * @returns {object|null} Tool object or null if not found
 */
export const findTool = (packageIndex, packager, toolName, version) => {
    const pkg = packageIndex.packages?.find(p => p.name.toLowerCase() === packager.toLowerCase());
    if (!pkg) return null;

    const tool = pkg.tools?.find(t =>
        t.name === toolName &&
        t.version === version
    );

    return tool ?? null;
};

/**
 * Get supported platforms for a tool
 * @param {object} tool - Tool object from package index
 * @returns {string[]} Array of OpenBlock platform names
 */
export const getToolPlatforms = (tool) => {
    if (!tool?.systems) return [];

    const platforms = new Set();
    for (const system of tool.systems) {
        const openblockPlatform = toOpenBlockPlatform(system.host);
        if (openblockPlatform) {
            platforms.add(openblockPlatform);
        }
    }
    return Array.from(platforms);
};

/**
 * Get tool system info for a specific platform
 * @param {object} tool - Tool object from package index
 * @param {string} targetPlatform - Target OpenBlock platform (e.g., 'win32-x64')
 * @returns {object|null} System object with url, checksum, size, or null if not found
 */
export const getToolSystemForPlatform = (tool, targetPlatform) => {
    if (!tool?.systems) return null;

    for (const system of tool.systems) {
        const openblockPlatform = toOpenBlockPlatform(system.host);
        if (openblockPlatform === targetPlatform) {
            return {
                url: system.url,
                checksum: system.checksum,
                size: system.size,
                archiveFileName: system.archiveFileName,
                host: system.host
            };
        }
    }
    return null;
};

/**
 * Collect all download resources for a core and its dependencies for a specific platform
 * @param {object} packageIndex - Arduino package index (merged from all sources)
 * @param {string} packager - Packager name (e.g., 'arduino')
 * @param {string} architecture - Architecture name (e.g., 'avr')
 * @param {string} version - Core version
 * @param {string} targetPlatform - Target OpenBlock platform (e.g., 'win32-x64')
 * @returns {object} Download manifest with platform and tools info
 */
export const collectDownloadResources = (packageIndex, packager, architecture, version, targetPlatform) => {
    const result = {
        platform: null,
        tools: [],
        missingTools: [],  // Tools that don't have binaries for target platform
        errors: []
    };

    // Find the platform (core)
    const platform = findPlatform(packageIndex, packager, architecture, version);
    if (!platform) {
        result.errors.push(`Platform not found: ${packager}:${architecture}@${version}`);
        return result;
    }

    // Platform download info (platform core is architecture-independent)
    result.platform = {
        packager,
        architecture,
        version,
        url: platform.url,
        checksum: platform.checksum,
        size: platform.size,
        archiveFileName: platform.archiveFileName
    };

    // Collect tool dependencies
    const toolDeps = getToolDependencies(platform);
    for (const dep of toolDeps) {
        const toolPackager = dep.packager;
        const toolName = dep.name;
        const toolVersion = dep.version;

        // Find the tool in the package index
        const tool = findTool(packageIndex, toolPackager, toolName, toolVersion);
        if (!tool) {
            result.errors.push(`Tool not found: ${toolPackager}/${toolName}@${toolVersion}`);
            continue;
        }

        // Get system for target platform
        const system = getToolSystemForPlatform(tool, targetPlatform);
        if (!system) {
            // Tool doesn't have binaries for this platform - record as missing
            result.missingTools.push({
                packager: toolPackager,
                name: toolName,
                version: toolVersion
            });
            continue;
        }

        result.tools.push({
            packager: toolPackager,
            name: toolName,
            version: toolVersion,
            url: system.url,
            checksum: system.checksum,
            size: system.size,
            archiveFileName: system.archiveFileName
        });
    }

    return result;
};

/**
 * Compare semantic versions
 * @param {string} a - Version A
 * @param {string} b - Version B
 * @returns {number} -1 if a < b, 0 if a == b, 1 if a > b
 */
const compareVersions = (a, b) => {
    const partsA = a.split('.').map(n => parseInt(n, 10) || 0);
    const partsB = b.split('.').map(n => parseInt(n, 10) || 0);

    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
        const numA = partsA[i] ?? 0;
        const numB = partsB[i] ?? 0;
        if (numA < numB) return -1;
        if (numA > numB) return 1;
    }
    return 0;
};

/**
 * Parse core string (e.g., 'arduino:avr' or 'esp32:esp32')
 * @param {string} core - Core string
 * @returns {{packager: string, architecture: string}} Parsed core
 */
export const parseCore = (core) => {
    const [packager, architecture] = core.split(':');
    return { packager, architecture };
};

export default {
    fetchPackageIndex,
    findPlatform,
    getAvailableVersions,
    getToolDependencies,
    findTool,
    getToolPlatforms,
    getToolSystemForPlatform,
    collectDownloadResources,
    parseCore
};

