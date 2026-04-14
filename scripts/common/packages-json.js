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
 * Fields that are version-specific and belong in the versions[] array.
 * All other fields from a package entry are treated as display fields
 * at the top level of the package object.
 */
const VERSION_FIELDS = ['version', 'url', 'archiveFileName', 'checksum', 'size'];

/**
 * Compare two version strings (X.Y.Z) for descending sort.
 * @param {string} a - Version A
 * @param {string} b - Version B
 * @returns {number} Positive if b > a (sorts b before a)
 */
const compareVersionDesc = (a, b) => {
    const [aMajor, aMinor, aPatch] = a.version.split('.').map(Number);
    const [bMajor, bMinor, bPatch] = b.version.split('.').map(Number);
    if (bMajor !== aMajor) return bMajor - aMajor;
    if (bMinor !== aMinor) return bMinor - aMinor;
    return bPatch - aPatch;
};

/**
 * Migrate packages.json from the legacy flat per-version format to the current
 * nested per-plugin format, without re-downloading or rebuilding any packages.
 *
 * Legacy format: packages[type] is a flat array where each version of a plugin
 * is a separate object with all fields (including display fields) duplicated.
 *
 * New format: one top-level object per plugin with display fields from the
 * latest version and a nested versions[] array of download-specific entries.
 *
 * This function is idempotent: already-migrated entries (those that have a
 * versions[] array) are handled correctly alongside legacy flat entries.
 *
 * @param {object} packagesJson - Packages JSON data (may be old or new format)
 * @returns {object} Packages JSON in the current nested format
 */
export const migrateToNestedFormat = packagesJson => {
    const migrateType = (entries, idField) => {
        const grouped = new Map();

        for (const entry of entries) {
            const id = entry[idField];
            if (!id) continue;

            if (!grouped.has(id)) {
                grouped.set(id, {displayData: null, versions: []});
            }

            const group = grouped.get(id);

            if (Array.isArray(entry.versions)) {
                // Already in new format: merge its versions[] and take display fields
                // if we haven't seen this plugin yet
                if (!group.displayData) {
                    const displayData = {...entry};
                    delete displayData.versions;
                    group.displayData = displayData;
                }
                for (const v of entry.versions) {
                    if (!group.versions.some(existing => existing.version === v.version)) {
                        group.versions.push(v);
                    }
                }
            } else {
                // Legacy flat entry: split into display fields and version-specific entry
                const versionEntry = {};
                const displayData = {};
                for (const [key, value] of Object.entries(entry)) {
                    if (VERSION_FIELDS.includes(key)) {
                        versionEntry[key] = value;
                    } else {
                        displayData[key] = value;
                    }
                }

                // Use the first (highest-version) entry's display fields as the
                // canonical display data, since entries arrive sorted descending
                if (!group.displayData) {
                    group.displayData = displayData;
                }

                if (versionEntry.version &&
                    !group.versions.some(v => v.version === versionEntry.version)) {
                    group.versions.push(versionEntry);
                }
            }
        }

        return Array.from(grouped.values())
            .filter(({displayData}) => displayData !== null)
            .map(({displayData, versions}) => ({
                ...displayData,
                versions: versions.sort(compareVersionDesc)
            }))
            .sort((a, b) => (a[idField] || '').localeCompare(b[idField] || ''));
    };

    const packages = packagesJson?.packages ?? {};
    return {
        ...packagesJson,
        packages: {
            ...packages,
            devices: migrateType(packages.devices ?? [], 'deviceId'),
            extensions: migrateType(packages.extensions ?? [], 'extensionId')
        }
    };
};

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
 * Find all version entries for a package by ID.
 * @param {Array} packages - Packages array (devices or extensions)
 * @param {string} id - Package ID (deviceId or extensionId)
 * @returns {Array} versions[] array for the matching package, or empty array
 */
export const findPackageVersions = (packages, id) => {
    const pkg = packages.find(p => p.deviceId === id || p.extensionId === id);
    return pkg ? (pkg.versions || []) : [];
};

/**
 * Find a specific version entry within a package.
 * @param {Array} packages - Packages array (devices or extensions)
 * @param {string} id - Package ID (deviceId or extensionId)
 * @param {string} version - Version number
 * @returns {object|undefined} Version entry or undefined
 */
export const findPackageVersion = (packages, id, version) => {
    const pkg = packages.find(p => {
        const pkgId = p.deviceId || p.extensionId;
        return pkgId === id;
    });
    if (!pkg) return undefined;
    return (pkg.versions || []).find(v => v.version === version);
};

/**
 * Add or update a package version in packages.json.
 *
 * Each package is stored as a single top-level object containing display fields
 * (from the latest version) and a nested versions[] array of version-specific
 * download entries. This function performs an upsert:
 *   - If the package ID already exists: updates display fields and upserts the
 *     version entry inside versions[] (add if new, replace if already present).
 *   - If the package ID is new: creates a new top-level entry.
 *
 * @param {object} packagesJson - Packages JSON data
 * @param {string} type - Package type ('devices' or 'extensions')
 * @param {object} packageData - Full package data (display fields + version fields combined)
 * @returns {object} Updated packages JSON
 */
export const addPackageVersion = (packagesJson, type, packageData) => {
    const idField = type === 'devices' ? 'deviceId' : 'extensionId';
    const id = packageData[idField];

    // Split packageData into version-specific entry and display fields
    const versionEntry = {};
    const displayData = {};
    for (const [key, value] of Object.entries(packageData)) {
        if (VERSION_FIELDS.includes(key)) {
            versionEntry[key] = value;
        } else {
            displayData[key] = value;
        }
    }

    const packages = [...(packagesJson?.packages?.[type] ?? [])];
    const existingIndex = packages.findIndex(p => p[idField] === id);

    if (existingIndex >= 0) {
        // Package exists: update display fields and upsert version entry
        const existing = {...packages[existingIndex]};

        // Overwrite display fields with the incoming version's metadata
        Object.assign(existing, displayData);

        // Upsert the version entry in versions[]
        const versions = [...(existing.versions || [])];
        const versionIndex = versions.findIndex(v => v.version === versionEntry.version);
        if (versionIndex >= 0) {
            versions[versionIndex] = versionEntry;
        } else {
            versions.push(versionEntry);
        }

        existing.versions = versions.sort(compareVersionDesc);
        packages[existingIndex] = existing;
    } else {
        // New package: create top-level entry with display fields and versions[]
        packages.push({...displayData, versions: [versionEntry]});

        // Keep packages sorted by ID ascending
        packages.sort((a, b) => {
            const aId = a[idField] || '';
            const bId = b[idField] || '';
            return aId.localeCompare(bId);
        });
    }

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
