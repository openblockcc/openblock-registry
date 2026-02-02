/**
 * Plugin processor module
 * Handles validation, building, and i18n extraction for plugins
 */

import {execSync} from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import logger from '../common/logger.js';

/**
 * Check if openblock-registry-cli is available
 * @returns {Promise<boolean>} True if CLI is available
 */
const checkCliAvailable = async () => {
    try {
        execSync('npx openblock-registry-cli --version', {stdio: 'pipe'});
        return true;
    } catch (err) {
        logger.error('openblock-registry-cli not found. Please install it globally or locally.');
        return false;
    }
};

/**
 * Run a command in a directory
 * @param {string} command - Command to run
 * @param {string} cwd - Working directory
 * @returns {Promise<object>} Command execution result with success, stdout, stderr, and error properties
 */
const runCommand = async (command, cwd) => {
    try {
        const stdout = execSync(command, {
            cwd,
            encoding: 'utf-8',
            stdio: 'pipe'
        });
        return {success: true, stdout};
    } catch (err) {
        return {
            success: false,
            stdout: err.stdout?.toString() || '',
            stderr: err.stderr?.toString() || '',
            error: err.message
        };
    }
};

/**
 * Validate plugin using openblock-registry-cli
 * @param {string} pluginDir - Plugin directory path
 * @param {string} type - Plugin type (devices/extensions)
 * @returns {Promise<object>} Validation result with valid and errors properties
 */
export const validatePlugin = async (pluginDir, type) => {
    logger.debug(`Validating plugin in ${pluginDir}...`);

    const errors = [];

    try {
        // Check if package.json exists
        const packageJsonPath = path.join(pluginDir, 'package.json');
        try {
            await fs.access(packageJsonPath);
        } catch {
            errors.push('package.json not found');
            return {valid: false, errors};
        }

        // Read package.json
        const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));

        // Validate openblock configuration
        if (!packageJson.openblock) {
            errors.push('package.json missing "openblock" field');
            return {valid: false, errors};
        }

        // Validate ID based on type
        if (type === 'devices' && !packageJson.openblock.deviceId) {
            errors.push('package.json missing "openblock.deviceId" for device plugin');
        }
        if (type === 'extensions' && !packageJson.openblock.extensionId) {
            errors.push('package.json missing "openblock.extensionId" for extension plugin');
        }

        // Validate required files
        const requiredFiles = ['LICENSE', 'README.md'];
        for (const file of requiredFiles) {
            try {
                await fs.access(path.join(pluginDir, file));
            } catch {
                errors.push(`Required file missing: ${file}`);
            }
        }

        if (errors.length > 0) {
            return {valid: false, errors};
        }

        logger.debug('Plugin validation passed');
        return {valid: true, errors: []};

    } catch (err) {
        errors.push(`Validation error: ${err.message}`);
        return {valid: false, errors};
    }
};

/**
 * Build plugin using openblock-registry-cli
 * @param {string} pluginDir - Plugin directory path
 * @returns {Promise<object>} Build result with success, distPath, and error properties
 */
export const buildPlugin = async (pluginDir) => {
    logger.debug(`Building plugin in ${pluginDir}...`);

    try {
        // Check if package-lock.json exists, if so, install dependencies
        const lockPath = path.join(pluginDir, 'package-lock.json');
        try {
            await fs.access(lockPath);
            logger.debug('Installing dependencies...');
            const installResult = await runCommand('npm install --production', pluginDir);
            if (!installResult.success) {
                return {
                    success: false,
                    error: `npm install failed: ${installResult.error}`
                };
            }
        } catch {
            logger.debug('No package-lock.json found, skipping npm install');
        }

        // Run build command
        logger.debug('Running openblock-registry-cli build...');
        const buildResult = await runCommand('npx openblock-registry-cli build', pluginDir);

        if (!buildResult.success) {
            return {
                success: false,
                error: `Build failed: ${buildResult.error || buildResult.stderr}`
            };
        }

        const distPath = path.join(pluginDir, 'dist');
        
        // Verify dist directory exists
        try {
            await fs.access(distPath);
        } catch {
            return {
                success: false,
                error: 'Build succeeded but dist/ directory not found'
            };
        }

        logger.debug(`Build successful, dist at ${distPath}`);
        return {success: true, distPath};

    } catch (err) {
        return {
            success: false,
            error: `Build error: ${err.message}`
        };
    }
};

/**
 * Extract translations using openblock-registry-cli
 * @param {string} pluginDir - Plugin directory path
 * @returns {Promise<object>} Extraction result with success, translationsPath, and error properties
 */
export const extractTranslations = async (pluginDir) => {
    logger.debug(`Extracting translations from ${pluginDir}...`);

    try {
        // Run i18n extract command
        const extractResult = await runCommand('npx openblock-registry-cli i18n extract', pluginDir);

        if (!extractResult.success) {
            // i18n extraction is optional, log warning but don't fail
            logger.warn(`Translation extraction failed: ${extractResult.error || extractResult.stderr}`);
            return {
                success: false,
                error: extractResult.error || extractResult.stderr
            };
        }

        const translationsPath = path.join(pluginDir, '.translations');

        // Verify .translations directory exists
        try {
            await fs.access(translationsPath);
        } catch {
            logger.warn('Translation extraction succeeded but .translations/ directory not found');
            return {
                success: false,
                error: '.translations/ directory not found'
            };
        }

        logger.debug(`Translations extracted to ${translationsPath}`);
        return {success: true, translationsPath};

    } catch (err) {
        logger.warn(`Translation extraction error: ${err.message}`);
        return {
            success: false,
            error: err.message
        };
    }
};

/**
 * Process a single version - complete workflow
 * Downloads, validates, builds, extracts translations
 * @param {object} options - Processing options
 * @param {string} options.owner - Repository owner
 * @param {string} options.repo - Repository name
 * @param {string} options.tag - Tag name
 * @param {string} options.type - Plugin type (devices/extensions)
 * @param {string} options.tempDir - Temporary directory for extraction
 * @returns {Promise<object>} Processing result with success, data, and error properties
 */
export const processVersion = async (options) => {
    const {owner, repo, tag, type, tempDir} = options;

    logger.info(`Processing ${owner}/${repo}@${tag}...`);

    try {
        // Import downloader (dynamic to avoid circular dependencies)
        const {downloadAndExtractTag} = await import('./github/downloader.js');

        // 1. Download and extract
        logger.debug('Downloading and extracting...');
        const {extractedPath, cleanup} = await downloadAndExtractTag(owner, repo, tag, tempDir);

        try {
            // 2. Validate plugin
            logger.debug('Validating plugin...');
            const validationResult = await validatePlugin(extractedPath, type);
            if (!validationResult.valid) {
                await cleanup();
                return {
                    success: false,
                    error: `Validation failed: ${validationResult.errors.join(', ')}`
                };
            }

            // 3. Build plugin
            logger.debug('Building plugin...');
            const buildResult = await buildPlugin(extractedPath);
            if (!buildResult.success) {
                await cleanup();
                return {
                    success: false,
                    error: buildResult.error
                };
            }

            // 4. Extract translations (optional)
            logger.debug('Extracting translations...');
            const translationsResult = await extractTranslations(extractedPath);

            // Return success with paths
            return {
                success: true,
                data: {
                    extractedPath,
                    distPath: buildResult.distPath,
                    translationsPath: translationsResult.translationsPath,
                    cleanup
                }
            };

        } catch (err) {
            await cleanup();
            throw err;
        }

    } catch (err) {
        logger.error(`Failed to process ${owner}/${repo}@${tag}: ${err.message}`);
        return {
            success: false,
            error: err.message
        };
    }
};

export default {
    validatePlugin,
    buildPlugin,
    extractTranslations,
    processVersion,
    checkCliAvailable
};
