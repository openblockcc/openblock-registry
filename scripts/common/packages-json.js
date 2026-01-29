/**
 * packages.json read/write utilities
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES_JSON_PATH = path.resolve(__dirname, '../../packages.json');
const REGISTRY_URL = 'https://registry.openblock.cc/packages.json';

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
    data.updatedAt = new Date().toISOString();
    const content = JSON.stringify(data, null, 4);
    await fs.writeFile(PACKAGES_JSON_PATH, content, 'utf-8');
    logger.success(`Updated packages.json`);
};

/**
 * Create empty packages.json structure
 * @returns {object} Empty packages structure
 */
export const createEmptyPackagesJson = () => ({
    schemaVersion: '1.0.0',
    updatedAt: new Date().toISOString(),
    packages: {
        devices: [],
        extensions: [],
        libraries: [],
        toolchains: []
    }
});

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

export default {
    readLocalPackagesJson,
    fetchRemotePackagesJson,
    writePackagesJson,
    createEmptyPackagesJson,
    getToolchains,
    updateToolchains,
    findToolchain
};

