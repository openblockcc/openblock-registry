/**
 * packages.json read/write utilities
 */

import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_JSON_PATH = path.resolve(__dirname, '../../packages.json');
const REGISTRY_URL = 'https://registry.openblock.cc/packages.json';

/**
 * Create empty packages.json structure
 * @returns {object} Empty packages structure
 */
export const createEmptyPackagesJson = () => ({
    packages: {
        devices: [],
        extensions: [],
        libraries: [],
        toolchains: []
    }
});

/**
 * Read packages.json from local file
 * @returns {Promise<object>} Packages JSON content
 */
export const readLocalPackagesJson = async () => {
    try {
        const content = await fs.readFile(PACKAGES_JSON_PATH, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.warn('packages.json not found, returning empty structure');
            return createEmptyPackagesJson();
        }
        throw err;
    }
};

/**
 * Fetch packages.json from remote registry
 * @returns {Promise<object>} Packages JSON content
 */
export const fetchRemotePackagesJson = async () => {
    try {
        const response = await fetch(REGISTRY_URL);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (err) {
        logger.warn(`Failed to fetch remote packages.json: ${err.message}`);
        return createEmptyPackagesJson();
    }
};

/**
 * Write packages.json to local file
 * @param {object} data - Packages JSON data
 */
export const writePackagesJson = async (data) => {
    const content = JSON.stringify(data, null, 4);
    await fs.writeFile(PACKAGES_JSON_PATH, content, 'utf-8');
    logger.success(`Updated packages.json`);
};

/**
 * Get toolchains from packages.json
 * @param {object} packagesJson - Packages JSON data
 * @returns {Array} Toolchains array
 */
export const getToolchains = (packagesJson) => {
    return packagesJson?.packages?.toolchains ?? [];
};

/**
 * Update toolchains in packages.json
 * @param {object} packagesJson - Packages JSON data
 * @param {Array} toolchains - New toolchains array
 * @returns {object} Updated packages JSON
 */
export const updateToolchains = (packagesJson, toolchains) => {
    return {
        ...packagesJson,
        packages: {
            ...packagesJson.packages,
            toolchains
        }
    };
};

/**
 * Find a toolchain entry by id and version
 * @param {Array} toolchains - Toolchains array
 * @param {string} id - Toolchain ID
 * @param {string} version - Toolchain version
 * @returns {object|undefined} Toolchain entry or undefined
 */
export const findToolchain = (toolchains, id, version) => {
    return toolchains.find(t => t.id === id && t.version === version);
};

/**
 * Get devices from packages.json
 * @param {object} packagesJson - Packages JSON data
 * @returns {Array} Devices array
 */
export const getDevices = (packagesJson) => {
    return packagesJson?.packages?.devices ?? [];
};

/**
 * Get extensions from packages.json
 * @param {object} packagesJson - Packages JSON data
 * @returns {Array} Extensions array
 */
export const getExtensions = (packagesJson) => {
    return packagesJson?.packages?.extensions ?? [];
};

/**
 * Find a package (device or extension) by ID
 * @param {Array} packages - Packages array (devices or extensions)
 * @param {string} id - Package ID (deviceId or extensionId)
 * @returns {Array} Array of all versions for this package
 */
export const findPackageVersions = (packages, id) => {
    return packages.filter(pkg => {
        return pkg.deviceId === id || pkg.extensionId === id;
    });
};

/**
 * Find a specific version of a package
 * @param {Array} packages - Packages array (devices or extensions)
 * @param {string} id - Package ID (deviceId or extensionId)
 * @param {string} version - Version number
 * @returns {object|undefined} Package entry or undefined
 */
export const findPackageVersion = (packages, id, version) => {
    return packages.find(pkg => {
        const pkgId = pkg.deviceId || pkg.extensionId;
        return pkgId === id && pkg.version === version;
    });
};

/**
 * Add or update a package version in packages.json
 * @param {object} packagesJson - Packages JSON data
 * @param {string} type - Package type ('devices' or 'extensions')
 * @param {object} packageData - Package data to add
 * @returns {object} Updated packages JSON
 */
export const addPackageVersion = (packagesJson, type, packageData) => {
    const packages = [...(packagesJson?.packages?.[type] ?? [])];

    // Add the new version
    packages.push(packageData);

    // Sort packages: by ID (ascending), then by version (descending)
    packages.sort((a, b) => {
        const aId = a.deviceId || a.extensionId;
        const bId = b.deviceId || b.extensionId;

        if (aId !== bId) {
            return aId.localeCompare(bId);
        }

        // Compare versions (descending)
        const [aMajor, aMinor, aPatch] = a.version.split('.').map(Number);
        const [bMajor, bMinor, bPatch] = b.version.split('.').map(Number);

        if (bMajor !== aMajor) return bMajor - aMajor;
        if (bMinor !== aMinor) return bMinor - aMinor;
        return bPatch - aPatch;
    });

    return {
        ...packagesJson,
        packages: {
            ...packagesJson.packages,
            [type]: packages
        }
    };
};

/**
 * Update devices in packages.json
 * @param {object} packagesJson - Packages JSON data
 * @param {Array} devices - New devices array
 * @returns {object} Updated packages JSON
 */
export const updateDevices = (packagesJson, devices) => {
    return {
        ...packagesJson,
        packages: {
            ...packagesJson.packages,
            devices
        }
    };
};

/**
 * Update extensions in packages.json
 * @param {object} packagesJson - Packages JSON data
 * @param {Array} extensions - New extensions array
 * @returns {object} Updated packages JSON
 */
export const updateExtensions = (packagesJson, extensions) => {
    return {
        ...packagesJson,
        packages: {
            ...packagesJson.packages,
            extensions
        }
    };
};

export default {
    readLocalPackagesJson,
    fetchRemotePackagesJson,
    writePackagesJson,
    createEmptyPackagesJson,
    getToolchains,
    updateToolchains,
    findToolchain,
    getDevices,
    getExtensions,
    findPackageVersions,
    findPackageVersion,
    addPackageVersion,
    updateDevices,
    updateExtensions
};
