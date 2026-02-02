/**
 * Registry.json Validator
 * Validates registry.json structure and new repository entries
 */

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load registry schema
 * @returns {Promise<object>} JSON Schema
 */
const loadSchema = async () => {
    const schemaPath = path.resolve(__dirname, '../../schemas/registry.schema.json');
    const content = await fs.readFile(schemaPath, 'utf-8');
    return JSON.parse(content);
};

/**
 * Find new entries by comparing PR and base
 * @param {Array} prList - PR list
 * @param {Array} baseList - Base list
 * @returns {Array} New entries
 */
const findNewEntries = (prList, baseList) => {
    const baseSet = new Set(baseList || []);
    return (prList || []).filter(url => !baseSet.has(url));
};

/**
 * Extract repo info from GitHub URL
 * @param {string} url - GitHub repository URL
 * @returns {object} {owner, repo}
 */
const parseGitHubUrl = (url) => {
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    return {owner: match[1], repo: match[2]};
};

/**
 * Check if repository exists and is accessible
 * @param {object} repoInfo - {owner, repo}
 * @returns {Promise<object>} Validation result
 */
const checkRepositoryExists = async (repoInfo) => {
    const {owner, repo} = repoInfo;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}`;

    try {
        const response = await fetch(apiUrl, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'OpenBlock-Registry-Validator'
            }
        });

        if (response.status === 404) {
            return {valid: false, error: 'Repository not found'};
        }

        if (!response.ok) {
            return {valid: false, error: `GitHub API returned ${response.status}`};
        }

        const data = await response.json();

        // Check if repository is archived or disabled
        if (data.archived) {
            return {valid: false, error: 'Repository is archived'};
        }

        if (data.disabled) {
            return {valid: false, error: 'Repository is disabled'};
        }

        return {valid: true, defaultBranch: data.default_branch};
    } catch (err) {
        return {valid: false, error: `Failed to check repository: ${err.message}`};
    }
};

/**
 * Fetch and validate package.json from repository
 * @param {object} repoInfo - {owner, repo}
 * @param {string} branch - Branch name
 * @returns {Promise<object>} Validation result
 */
const fetchAndValidatePackageJson = async (repoInfo, branch) => {
    const {owner, repo} = repoInfo;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/package.json`;

    try {
        const response = await fetch(rawUrl);

        if (response.status === 404) {
            return {valid: false, error: 'package.json not found'};
        }

        if (!response.ok) {
            return {valid: false, error: `Failed to fetch package.json (${response.status})`};
        }

        const text = await response.text();
        let packageJson;

        try {
            packageJson = JSON.parse(text);
        } catch (err) {
            return {valid: false, error: 'package.json is not valid JSON'};
        }

        // Check if openblock field exists
        if (!packageJson.openblock) {
            return {valid: false, error: 'Missing openblock field in package.json'};
        }

        return {valid: true, packageJson};
    } catch (err) {
        return {valid: false, error: `Failed to fetch package.json: ${err.message}`};
    }
};

/**
 * Verify openblock.type matches expected type
 * @param {object} packageJson - Parsed package.json
 * @param {string} expectedType - Expected type (device/extension)
 * @returns {object} Validation result
 */
const verifyOpenBlockType = (packageJson, expectedType) => {
    // Only device type requires openblock.type field
    // Extension type does not have openblock.type
    if (expectedType === 'device') {
        const actualType = packageJson.openblock?.type;

        if (!actualType) {
            return {valid: false, error: 'Missing openblock.type field'};
        }

        const validDeviceTypes = ['arduino', 'microPython', 'microbit'];
        if (!validDeviceTypes.includes(actualType)) {
            return {valid: false, error: `Invalid device type: '${actualType}'. Must be one of: ${validDeviceTypes.join(', ')}`};
        }
    }

    return {valid: true};
};

/**
 * Validate version format (semver: x.y.z)
 * @param {string} version - Version string
 * @returns {boolean} True if valid
 */
const isValidVersion = (version) => {
    if (!version || typeof version !== 'string') return false;
    return /^\d+\.\d+\.\d+$/.test(version);
};

/**
 * Validate formatMessage structure
 * @param {any} value - Value to check
 * @returns {boolean} True if valid formatMessage or string
 */
const isValidFormatMessageOrString = (value) => {
    if (typeof value === 'string') return true;
    if (typeof value === 'object' && value !== null) {
        const fm = value.formatMessage;
        if (fm && typeof fm === 'object') {
            return typeof fm.id === 'string' && typeof fm.default === 'string';
        }
    }
    return false;
};

/**
 * Check if file exists in repository
 * @param {object} repoInfo - {owner, repo}
 * @param {string} branch - Branch name
 * @param {string} filePath - File path in repository
 * @returns {Promise<boolean>} True if file exists
 */
const checkFileExists = async (repoInfo, branch, filePath) => {
    const {owner, repo} = repoInfo;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;

    try {
        const response = await fetch(rawUrl, {method: 'HEAD'});
        return response.ok;
    } catch (err) {
        return false;
    }
};

/**
 * Check for required files (LICENSE, README.md)
 * @param {object} repoInfo - {owner, repo}
 * @param {string} branch - Branch name
 * @returns {Promise<object>} Validation result
 */
const checkRequiredFiles = async (repoInfo, branch) => {
    const requiredFiles = ['LICENSE', 'README.md'];
    const missingFiles = [];

    for (const file of requiredFiles) {
        const exists = await checkFileExists(repoInfo, branch, file);
        if (!exists) {
            missingFiles.push(file);
        }
    }

    if (missingFiles.length > 0) {
        return {valid: false, error: `Missing required files: ${missingFiles.join(', ')}`};
    }

    return {valid: true};
};

/**
 * Validate version tags exist
 * @param {object} repoInfo - {owner, repo}
 * @param {string} version - Version from package.json
 * @returns {Promise<object>} Validation result
 */
const validateVersionTags = async (repoInfo, version) => {
    const {owner, repo} = repoInfo;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/tags`;

    try {
        const response = await fetch(apiUrl, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'OpenBlock-Registry-Validator'
            }
        });

        if (!response.ok) {
            return {valid: false, error: `Failed to fetch tags: ${response.status}`};
        }

        const tags = await response.json();

        // Check if version tag exists (v1.0.0 or 1.0.0)
        const versionTag = `v${version}`;
        const hasTag = tags.some(tag => tag.name === version || tag.name === versionTag);

        if (!hasTag) {
            return {valid: false, error: `Version tag '${version}' or '${versionTag}' not found in repository`};
        }

        return {valid: true};
    } catch (err) {
        return {valid: false, error: `Failed to validate version tags: ${err.message}`};
    }
};

/**
 * Fetch and parse translations file
 * @param {object} repoInfo - {owner, repo}
 * @param {string} branch - Branch name
 * @param {string} translationsPath - Path to translations file
 * @returns {Promise<object|null>} Parsed translations or null
 */
const fetchTranslationsFile = async (repoInfo, branch, translationsPath) => {
    const {owner, repo} = repoInfo;
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${translationsPath}`;

    try {
        const response = await fetch(rawUrl);
        if (!response.ok) return null;

        const content = await response.text();

        // Parse ES module export (export default {...})
        // Remove comments and extract the object
        const cleanContent = content
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove block comments
            .replace(/\/\/.*/g, ''); // Remove line comments

        const match = cleanContent.match(/export\s+default\s+({[\s\S]*});?\s*$/);
        if (!match) return null;

        // Use eval to parse the object (safe in this context as we're validating user repos)
        // eslint-disable-next-line no-eval
        const translations = eval(`(${match[1]})`);
        return translations;
    } catch (err) {
        return null;
    }
};

/**
 * Validate translation file consistency and namespace
 * @param {object} packageJson - Parsed package.json
 * @param {string} type - Expected type (device/extension)
 * @param {object} repoInfo - {owner, repo}
 * @param {string} branch - Branch name
 * @returns {Promise<object>} Validation result
 */
const validateTranslations = async (packageJson, type, repoInfo, branch) => {
    const errors = [];
    const openblock = packageJson.openblock;

    // Get translations file path
    const translationsPath = openblock.translations?.replace(/^\.\//, '');
    if (!translationsPath) {
        return {valid: false, error: 'Missing translations path'};
    }

    // Fetch translations file
    const translations = await fetchTranslationsFile(repoInfo, branch, translationsPath);
    if (!translations) {
        return {valid: false, error: 'Failed to parse translations file'};
    }

    // Check interface section exists
    if (!translations.interface) {
        errors.push('Missing "interface" section in translations file');
        return {valid: false, error: errors.join('; ')};
    }

    // Get the plugin ID (deviceId or extensionId)
    const pluginId = type === 'device' ? openblock.deviceId : openblock.extensionId;
    if (!pluginId) {
        return {valid: false, error: `Missing ${type}Id in package.json`};
    }

    // Expected namespace prefix (only pluginId, no type prefix)
    const namespacePrefix = `${pluginId}.`;

    // Check name consistency (only if using formatMessage structure)
    if (typeof openblock.name === 'object' && openblock.name.formatMessage) {
        const nameId = openblock.name.formatMessage.id;
        const expectedNameId = `${pluginId}.name`;

        // Check if name ID matches expected format
        if (nameId !== expectedNameId) {
            errors.push(`name formatMessage id should be '${expectedNameId}', got '${nameId}'`);
        }

        // Check if name exists in translations interface
        const hasNameInTranslations = Object.values(translations.interface).some(lang =>
            lang && typeof lang === 'object' && nameId in lang
        );

        if (!hasNameInTranslations) {
            errors.push(`name formatMessage id '${nameId}' not found in translations interface`);
        }
    }
    // If name is a string, no validation needed (direct string is allowed)

    // Check description consistency (only if using formatMessage structure)
    if (typeof openblock.description === 'object' && openblock.description.formatMessage) {
        const descId = openblock.description.formatMessage.id;
        const expectedDescId = `${pluginId}.description`;

        // Check if description ID matches expected format
        if (descId !== expectedDescId) {
            errors.push(`description formatMessage id should be '${expectedDescId}', got '${descId}'`);
        }

        // Check if description exists in translations interface
        const hasDescInTranslations = Object.values(translations.interface).some(lang =>
            lang && typeof lang === 'object' && descId in lang
        );

        if (!hasDescInTranslations) {
            errors.push(`description formatMessage id '${descId}' not found in translations interface`);
        }
    }
    // If description is a string, no validation needed (direct string is allowed)

    // Check namespace for all translation keys
    // interface and extensions: {pluginId}.* (e.g., arduinoUnoR4Minima.description)
    // blocks: UPPERCASE_UNDERSCORE format (no pluginId prefix required)
    for (const section of ['interface', 'extensions']) {
        if (!translations[section]) continue;

        for (const [lang, keys] of Object.entries(translations[section])) {
            if (!keys || typeof keys !== 'object') continue;

            for (const key of Object.keys(keys)) {
                if (!key.startsWith(namespacePrefix)) {
                    errors.push(`Invalid namespace in ${section}.${lang}: '${key}' should start with '${namespacePrefix}'`);
                }
            }
        }
    }

    // Validate blocks section: should use UPPERCASE_UNDERSCORE format
    if (translations.blocks) {
        for (const [lang, keys] of Object.entries(translations.blocks)) {
            if (!keys || typeof keys !== 'object') continue;

            for (const key of Object.keys(keys)) {
                // Blocks should be UPPERCASE with underscores
                if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
                    errors.push(`Invalid block key format in blocks.${lang}: '${key}' should use UPPERCASE_UNDERSCORE format`);
                }
            }
        }
    }

    if (errors.length > 0) {
        return {valid: false, error: errors.join('; ')};
    }

    return {valid: true};
};

/**
 * Validate package.json structure
 * @param {object} packageJson - Parsed package.json
 * @param {string} type - Expected type (device/extension)
 * @param {object} repoInfo - {owner, repo}
 * @param {string} branch - Branch name
 * @returns {Promise<object>} Validation result
 */
const validatePackageJsonStructure = async (packageJson, type, repoInfo, branch) => {
    const errors = [];
    const openblock = packageJson.openblock;

    // Check version format
    if (!isValidVersion(packageJson.version)) {
        errors.push('Version must follow semver format (x.y.z)');
    }

    // Check author
    if (!packageJson.author) {
        errors.push('Missing author field');
    }

    // Check openblock.name
    if (!isValidFormatMessageOrString(openblock.name)) {
        errors.push('openblock.name must be a string or valid formatMessage structure');
    }

    // Check openblock.description
    if (!isValidFormatMessageOrString(openblock.description)) {
        errors.push('openblock.description must be a string or valid formatMessage structure');
    }

    // Check openblock.helpLink
    if (!openblock.helpLink || typeof openblock.helpLink !== 'string') {
        errors.push('Missing or invalid openblock.helpLink');
    }

    // Check openblock.iconURL
    if (!openblock.iconURL || typeof openblock.iconURL !== 'string') {
        errors.push('Missing or invalid openblock.iconURL');
    } else {
        // Check if icon file exists
        const iconPath = openblock.iconURL.replace(/^\.\//, '');
        const iconExists = await checkFileExists(repoInfo, branch, iconPath);
        if (!iconExists) {
            errors.push(`Icon file not found: ${openblock.iconURL}`);
        }
    }

    // Check translations (common for both device and extension)
    if (!openblock.translations || typeof openblock.translations !== 'string') {
        errors.push('Missing or invalid openblock.translations');
    } else {
        const translationsPath = openblock.translations.replace(/^\.\//, '');
        const translationsExists = await checkFileExists(repoInfo, branch, translationsPath);
        if (!translationsExists) {
            errors.push(`Translations file not found: ${openblock.translations}`);
        }
    }

    // Type-specific validation
    if (type === 'device') {
        // Check deviceId
        if (!openblock.deviceId || typeof openblock.deviceId !== 'string') {
            errors.push('Missing or invalid openblock.deviceId');
        }

        // Check manufactor
        if (!openblock.manufactor || typeof openblock.manufactor !== 'string') {
            errors.push('Missing or invalid openblock.manufactor');
        }

        // Check learnMore
        if (!openblock.learnMore || typeof openblock.learnMore !== 'string') {
            errors.push('Missing or invalid openblock.learnMore');
        }

        // Check type (arduino | microPython | microbit)
        const validDeviceTypes = ['arduino', 'microPython', 'microbit'];
        if (!openblock.type || !validDeviceTypes.includes(openblock.type)) {
            errors.push(`openblock.type must be one of: ${validDeviceTypes.join(', ')}`);
        }

        // Check bluetoothRequired
        if (typeof openblock.bluetoothRequired !== 'boolean') {
            errors.push('openblock.bluetoothRequired must be a boolean');
        }

        // Check serialportRequired
        if (typeof openblock.serialportRequired !== 'boolean') {
            errors.push('openblock.serialportRequired must be a boolean');
        }

        // Check internetConnectionRequired
        if (typeof openblock.internetConnectionRequired !== 'boolean') {
            errors.push('openblock.internetConnectionRequired must be a boolean');
        }

        // Check programMode
        const validProgramModes = ['realtime', 'upload'];
        if (!Array.isArray(openblock.programMode) || openblock.programMode.length === 0) {
            errors.push('openblock.programMode must be a non-empty array');
        } else {
            const invalidModes = openblock.programMode.filter(m => !validProgramModes.includes(m));
            if (invalidModes.length > 0) {
                errors.push(`Invalid programMode values: ${invalidModes.join(', ')}. Must be: ${validProgramModes.join(', ')}`);
            }
        }

        // Check programLanguage
        const validProgramLanguages = ['block', 'cpp', 'microPython'];
        if (!Array.isArray(openblock.programLanguage) || openblock.programLanguage.length === 0) {
            errors.push('openblock.programLanguage must be a non-empty array');
        } else {
            const invalidLangs = openblock.programLanguage.filter(l => !validProgramLanguages.includes(l));
            if (invalidLangs.length > 0) {
                errors.push(`Invalid programLanguage values: ${invalidLangs.join(', ')}. Must be: ${validProgramLanguages.join(', ')}`);
            }
        }

        // Check tags
        const validDeviceTags = ['arduino', 'micropython', 'kit'];
        if (!Array.isArray(openblock.tags) || openblock.tags.length === 0) {
            errors.push('openblock.tags must be a non-empty array');
        } else {
            const invalidTags = openblock.tags.filter(t => !validDeviceTags.includes(t));
            if (invalidTags.length > 0) {
                errors.push(`Invalid tags: ${invalidTags.join(', ')}. Must be: ${validDeviceTags.join(', ')}`);
            }
        }
    } else if (type === 'extension') {
        // Check extensionId
        if (!openblock.extensionId || typeof openblock.extensionId !== 'string') {
            errors.push('Missing or invalid openblock.extensionId');
        }

        // Check supportDevice
        if (!Array.isArray(openblock.supportDevice) || openblock.supportDevice.length === 0) {
            errors.push('openblock.supportDevice must be a non-empty array');
        }

        // Check tags
        const validExtensionTags = ['ai', 'kit', 'sensor', 'actuator', 'display', 'communication', 'audio', 'data', 'control', 'other'];
        if (!Array.isArray(openblock.tags) || openblock.tags.length === 0) {
            errors.push('openblock.tags must be a non-empty array');
        } else {
            const invalidTags = openblock.tags.filter(t => !validExtensionTags.includes(t));
            if (invalidTags.length > 0) {
                errors.push(`Invalid tags: ${invalidTags.join(', ')}. Must be: ${validExtensionTags.join(', ')}`);
            }
        }
    }

    if (errors.length > 0) {
        return {valid: false, error: errors.join('; ')};
    }

    return {valid: true};
};

/**
 * Validate a single repository
 * @param {string} url - Repository URL
 * @param {string} type - Expected type (device/extension)
 * @param {Set<string>} existingIds - Set of existing plugin IDs from R2
 * @returns {Promise<object>} Validation result
 */
const validateRepository = async (url, type, existingIds) => {
    const repoInfo = parseGitHubUrl(url);
    if (!repoInfo) {
        return {valid: false, error: 'Invalid GitHub URL format'};
    }

    // 1. Check repository exists and is accessible
    const repoCheck = await checkRepositoryExists(repoInfo);
    if (!repoCheck.valid) {
        return repoCheck;
    }

    // 2. Fetch and validate package.json
    const packageJsonCheck = await fetchAndValidatePackageJson(repoInfo, repoCheck.defaultBranch);
    if (!packageJsonCheck.valid) {
        return packageJsonCheck;
    }

    // 3. Verify openblock.type matches expected type
    const typeCheck = verifyOpenBlockType(packageJsonCheck.packageJson, type);
    if (!typeCheck.valid) {
        return typeCheck;
    }

    // 4. Check for duplicate plugin ID
    const openblock = packageJsonCheck.packageJson.openblock;
    const pluginId = type === 'device' ? openblock.deviceId : openblock.extensionId;
    if (pluginId && existingIds.has(pluginId)) {
        return {valid: false, error: `Plugin ID '${pluginId}' already exists`};
    }

    // 5. Validate package.json structure
    const structureCheck = await validatePackageJsonStructure(packageJsonCheck.packageJson, type, repoInfo, repoCheck.defaultBranch);
    if (!structureCheck.valid) {
        return structureCheck;
    }

    // 6. Check for required files (LICENSE, README.md)
    const requiredFilesCheck = await checkRequiredFiles(repoInfo, repoCheck.defaultBranch);
    if (!requiredFilesCheck.valid) {
        return requiredFilesCheck;
    }

    // 7. Validate version tags exist
    const versionTagCheck = await validateVersionTags(repoInfo, packageJsonCheck.packageJson.version);
    if (!versionTagCheck.valid) {
        return versionTagCheck;
    }

    // 8. Validate translation file consistency and namespace
    const translationsCheck = await validateTranslations(packageJsonCheck.packageJson, type, repoInfo, repoCheck.defaultBranch);
    if (!translationsCheck.valid) {
        return translationsCheck;
    }

    return {valid: true};
};

/**
 * Fetch packages.json from R2
 * @returns {Promise<object|null>} Packages data or null if not found
 */
const fetchR2Packages = async () => {
    const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || 'https://registry.openblock.cc';
    const packagesUrl = `${R2_PUBLIC_URL}/packages.json`;

    try {
        const response = await fetch(packagesUrl);
        if (!response.ok) {
            return null;
        }
        return await response.json();
    } catch (err) {
        return null;
    }
};

/**
 * Get all existing plugin IDs from R2 packages.json
 * @returns {Promise<Set<string>>} Set of existing plugin IDs (deviceId and extensionId)
 */
const getExistingPluginIds = async () => {
    const packages = await fetchR2Packages();
    const ids = new Set();

    if (!packages) {
        return ids;
    }

    // Collect device IDs
    if (packages.device && Array.isArray(packages.device)) {
        for (const device of packages.device) {
            if (device.deviceId) {
                ids.add(device.deviceId);
            }
        }
    }

    // Collect extension IDs
    if (packages.extension && Array.isArray(packages.extension)) {
        for (const extension of packages.extension) {
            if (extension.extensionId) {
                ids.add(extension.extensionId);
            }
        }
    }

    return ids;
};

/**
 * Validate registry.json
 * @param {object} prRegistry - PR registry.json content
 * @param {object} baseRegistry - Base registry.json content
 * @returns {Promise<object>} Validation result
 */
export const validateRegistry = async (prRegistry, baseRegistry) => {
    const result = {
        checked: true,
        errors: [],
        added: []
    };

    // Schema validation
    try {
        const schema = await loadSchema();
        const ajv = new Ajv({allErrors: true});
        addFormats(ajv);
        const validate = ajv.compile(schema);

        if (!validate(prRegistry)) {
            for (const error of validate.errors) {
                result.errors.push(`Schema: ${error.instancePath} ${error.message}`);
            }
            return result;
        }
    } catch (err) {
        result.errors.push(`Schema validation error: ${err.message}`);
        return result;
    }

    // Get existing plugin IDs from R2
    const existingIds = await getExistingPluginIds();

    // Find new entries
    const newDevices = findNewEntries(prRegistry.devices, baseRegistry?.devices);
    const newExtensions = findNewEntries(prRegistry.extensions, baseRegistry?.extensions);

    // Validate new devices
    for (const url of newDevices) {
        const repoInfo = parseGitHubUrl(url);
        const repoName = repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : url;
        const validation = await validateRepository(url, 'device', existingIds);
        result.added.push({
            type: 'device',
            url,
            repo: repoName,
            ...validation
        });
        if (!validation.valid) {
            result.errors.push(`Device ${repoName}: ${validation.error}`);
        }
    }

    // Validate new extensions
    for (const url of newExtensions) {
        const repoInfo = parseGitHubUrl(url);
        const repoName = repoInfo ? `${repoInfo.owner}/${repoInfo.repo}` : url;
        const validation = await validateRepository(url, 'extension', existingIds);
        result.added.push({
            type: 'extension',
            url,
            repo: repoName,
            ...validation
        });
        if (!validation.valid) {
            result.errors.push(`Extension ${repoName}: ${validation.error}`);
        }
    }

    return result;
};
