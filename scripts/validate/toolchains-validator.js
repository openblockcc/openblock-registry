/**
 * Toolchains.json Validator
 * Validates toolchains.json structure and new toolchain entries
 */

import {parseCore} from '../toolchains/arduino/index-parser.js';
import {mergePackageIndexes} from '../toolchains/arduino/packager.js';

/**
 * Find new toolchain entries by comparing PR and base
 * @param {Array} prPackages - PR packages list
 * @param {Array} basePackages - Base packages list
 * @returns {Array} New entries
 */
const findNewEntries = (prPackages, basePackages) => {
    const baseIds = new Set((basePackages || []).map(p => p.id));
    return (prPackages || []).filter(p => !baseIds.has(p.id));
};

/**
 * Validate core format
 * @param {string} core - Core string (e.g., "arduino:avr")
 * @returns {boolean} True if valid
 */
const isValidCoreFormat = (core) => {
    if (!core || typeof core !== 'string') return false;
    const parts = core.split(':');
    return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
};

/**
 * Validate board_manager URLs are accessible
 * @param {Array} urls - Board manager URLs
 * @returns {Promise<object>} Validation result
 */
const validateBoardManagerUrls = async (urls) => {
    const errors = [];

    for (const url of urls) {
        try {
            const response = await fetch(url, {method: 'HEAD', timeout: 10000});
            if (!response.ok) {
                errors.push(`URL ${url} returned ${response.status}`);
            }
        } catch (err) {
            errors.push(`URL ${url} is not accessible: ${err.message}`);
        }
    }

    return {valid: errors.length === 0, errors};
};

/**
 * Validate core exists in Arduino Package Index
 * @param {string} core - Core string (e.g., "arduino:avr")
 * @param {Array} indexUrls - Board manager URLs
 * @returns {Promise<object>} Validation result
 */
const validateCoreExists = async (core, indexUrls) => {
    try {
        const {packager, architecture} = parseCore(core);
        const packageIndex = await mergePackageIndexes(indexUrls);

        // Find the packager in the index
        const packagerData = packageIndex.packages?.find(p => p.name === packager);
        if (!packagerData) {
            return {valid: false, error: `Packager '${packager}' not found in Arduino Package Index`};
        }

        // Find the platform (architecture)
        const platform = packagerData.platforms?.find(p => p.architecture === architecture);
        if (!platform) {
            return {valid: false, error: `Architecture '${architecture}' not found for packager '${packager}'`};
        }

        return {valid: true};
    } catch (err) {
        return {valid: false, error: `Failed to validate core: ${err.message}`};
    }
};

/**
 * Validate a single toolchain entry
 * @param {object} pkg - Package config
 * @param {Array} boardManagerUrls - Board manager URLs from config
 * @returns {Promise<object>} Validation result
 */
const validateToolchainEntry = async (pkg, boardManagerUrls) => {
    // Check required fields
    if (!pkg.id) {
        return {valid: false, error: 'Missing id field'};
    }

    if (!pkg.core) {
        return {valid: false, error: 'Missing core field'};
    }

    // Validate core format
    if (!isValidCoreFormat(pkg.core)) {
        return {valid: false, error: `Invalid core format: ${pkg.core} (expected: packager:architecture)`};
    }

    // Validate core exists in Arduino Package Index
    const coreValidation = await validateCoreExists(pkg.core, boardManagerUrls);
    if (!coreValidation.valid) {
        return coreValidation;
    }

    return {valid: true};
};

/**
 * Validate toolchains.json
 * @param {object} prToolchains - PR toolchains.json content
 * @param {object} baseToolchains - Base toolchains.json content
 * @returns {Promise<object>} Validation result
 */
export const validateToolchains = async (prToolchains, baseToolchains) => {
    const result = {
        checked: true,
        errors: [],
        added: []
    };

    // Basic structure validation
    if (!prToolchains.arduino) {
        result.errors.push('Missing arduino section');
        return result;
    }

    if (!Array.isArray(prToolchains.arduino.packages)) {
        result.errors.push('arduino.packages must be an array');
        return result;
    }

    // Get board_manager URLs
    const boardManagerUrls = prToolchains.arduino.board_manager?.additional_urls || [];
    // Always include the main Arduino package index
    if (!boardManagerUrls.includes('https://downloads.arduino.cc/packages/package_index.json')) {
        boardManagerUrls.unshift('https://downloads.arduino.cc/packages/package_index.json');
    }

    // Validate board_manager URLs are accessible
    const urlValidation = await validateBoardManagerUrls(boardManagerUrls);
    if (!urlValidation.valid) {
        for (const error of urlValidation.errors) {
            result.errors.push(`Board Manager URL: ${error}`);
        }
    }

    // Find new entries
    const newPackages = findNewEntries(
        prToolchains.arduino?.packages,
        baseToolchains?.arduino?.packages
    );

    // Validate new entries
    for (const pkg of newPackages) {
        const validation = await validateToolchainEntry(pkg, boardManagerUrls);
        result.added.push({
            id: pkg.id,
            core: pkg.core || 'N/A',
            ...validation
        });
        if (!validation.valid) {
            result.errors.push(`Toolchain ${pkg.id}: ${validation.error}`);
        }
    }

    return result;
};
