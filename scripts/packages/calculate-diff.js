/**
 * Calculate diff between registry.json and packages.json
 * Determines which package versions need to be synced
 */

import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import logger from '../common/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_JSON_PATH = path.resolve(__dirname, '../../registry.json');

/**
 * Read registry.json
 * @returns {Promise<{devices: string[], extensions: string[]}>} Registry config
 */
export const readRegistryJson = async () => {
    try {
        const content = await fs.readFile(REGISTRY_JSON_PATH, 'utf-8');
        const data = JSON.parse(content);
        
        return {
            devices: data.devices ?? [],
            extensions: data.extensions ?? []
        };
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.warn('registry.json not found, returning empty config');
            return {devices: [], extensions: []};
        }
        throw err;
    }
};

/**
 * Parse GitHub repository URL
 * @param {string} url - GitHub repository URL
 * @returns {{owner: string, repo: string}} Owner and repo name
 */
export const parseRepoUrl = (url) => {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (!match) {
        throw new Error(`Invalid GitHub URL: ${url}`);
    }
    return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, '')
    };
};

/**
 * Validate semantic version format (X.Y.Z only, no 'v' prefix)
 * @param {string} tag - Tag name
 * @returns {boolean} True if valid semantic version
 */
export const isValidSemver = (tag) => {
    // Only accept X.Y.Z format (no 'v' prefix, no pre-release, no build metadata)
    const semverRegex = /^(\d+)\.(\d+)\.(\d+)$/;
    return semverRegex.test(tag);
};

/**
 * Compare semantic versions
 * @param {string} a - Version A
 * @param {string} b - Version B
 * @returns {number} -1 if a < b, 0 if a === b, 1 if a > b
 */
export const compareSemver = (a, b) => {
    const [aMajor, aMinor, aPatch] = a.split('.').map(Number);
    const [bMajor, bMinor, bPatch] = b.split('.').map(Number);

    if (aMajor !== bMajor) return aMajor - bMajor;
    if (aMinor !== bMinor) return aMinor - bMinor;
    return aPatch - bPatch;
};

/**
 * Calculate which versions need to be synced
 * @param {Array<{name: string, commit: object}>} repoTags - Tags from GitHub repository
 * @param {Array<{version: string}>} currentVersions - Existing versions in packages.json
 * @returns {{toAdd: Array<string>, toSkip: Array<string>}} Versions to add and skip
 */
export const calculateDiff = (repoTags, currentVersions) => {
    const toAdd = [];
    const toSkip = [];

    // Filter valid semantic version tags
    const validTags = repoTags
        .map(tag => tag.name)
        .filter(isValidSemver);

    // Build set of existing versions for quick lookup
    const existingVersions = new Set(
        currentVersions.map(v => v.version)
    );

    // Determine which versions to add
    for (const version of validTags) {
        if (existingVersions.has(version)) {
            toSkip.push(version);
        } else {
            toAdd.push(version);
        }
    }

    // Sort versions (newest first)
    toAdd.sort((a, b) => -compareSemver(a, b));
    toSkip.sort((a, b) => -compareSemver(a, b));

    return {toAdd, toSkip};
};

/**
 * Get all versions for a package from packages.json
 * @param {Array} packages - Packages array (devices or extensions)
 * @param {string} id - Package ID (deviceId or extensionId)
 * @returns {Array<{version: string}>} Array of version objects
 */
export const getPackageVersions = (packages, id) => {
    return packages
        .filter(pkg => {
            // Check both deviceId and extensionId
            return pkg.deviceId === id || pkg.extensionId === id;
        })
        .map(pkg => ({version: pkg.version}));
};

/**
 * Build a summary of repository sync status
 * @param {object} registry - Registry config
 * @param {object} packagesJson - Packages JSON data
 * @param {Function} fetchTagsFn - Function to fetch tags from GitHub
 * @returns {Promise<Array>} Array of repository status objects
 */
export const buildSyncSummary = async (registry, packagesJson, fetchTagsFn) => {
    const summary = [];

    // Process devices
    for (const repoUrl of registry.devices) {
        const {owner, repo} = parseRepoUrl(repoUrl);
        const tags = await fetchTagsFn(owner, repo);
        
        // We need to fetch package.json to get deviceId
        // This is a simplified version - actual implementation would need to fetch package.json
        const validTags = tags.filter(tag => isValidSemver(tag.name));
        
        summary.push({
            type: 'device',
            repoUrl,
            owner,
            repo,
            totalTags: validTags.length,
            tags: validTags.map(t => t.name)
        });
    }

    // Process extensions
    for (const repoUrl of registry.extensions) {
        const {owner, repo} = parseRepoUrl(repoUrl);
        const tags = await fetchTagsFn(owner, repo);
        
        const validTags = tags.filter(tag => isValidSemver(tag.name));
        
        summary.push({
            type: 'extension',
            repoUrl,
            owner,
            repo,
            totalTags: validTags.length,
            tags: validTags.map(t => t.name)
        });
    }

    return summary;
};

export default {
    readRegistryJson,
    parseRepoUrl,
    isValidSemver,
    compareSemver,
    calculateDiff,
    getPackageVersions,
    buildSyncSummary
};

