/**
 * Merge multiple packages.json files from different platform builds
 * Used by GitHub Actions to combine results from parallel jobs
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../common/logger.js';
import {
    readLocalPackagesJson,
    writePackagesJson,
    getToolchains,
    updateToolchains
} from '../common/packages-json.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read all packages.json files from artifacts directory
 * @param {string} artifactsDir - Directory containing platform subdirectories
 * @returns {Promise<Array<object>>} Array of packages.json contents
 */
const readArtifacts = async (artifactsDir) => {
    const entries = await fs.readdir(artifactsDir, { withFileTypes: true });
    const results = [];

    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('packages-json-')) {
            const filePath = path.join(artifactsDir, entry.name, 'packages.json');
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                results.push({
                    platform: entry.name.replace('packages-json-', ''),
                    data: JSON.parse(content)
                });
                logger.info(`Read: ${entry.name}/packages.json`);
            } catch (err) {
                logger.warn(`Failed to read ${filePath}: ${err.message}`);
            }
        }
    }

    return results;
};

/**
 * Merge toolchains from multiple packages.json files
 * @param {object} basePackagesJson - Base packages.json (current state)
 * @param {Array<object>} artifacts - Array of {platform, data} from artifacts
 * @returns {Array} Merged toolchains array
 */
const mergeToolchains = (basePackagesJson, artifacts) => {
    // Start with base toolchains as a map for easy lookup
    const toolchainMap = new Map();
    const baseToolchains = getToolchains(basePackagesJson);

    for (const toolchain of baseToolchains) {
        const key = `${toolchain.id}@${toolchain.version}`;
        toolchainMap.set(key, { ...toolchain, systems: [...(toolchain.systems ?? [])] });
    }

    // Merge in toolchains from each artifact
    for (const artifact of artifacts) {
        const artifactToolchains = getToolchains(artifact.data);

        for (const toolchain of artifactToolchains) {
            const key = `${toolchain.id}@${toolchain.version}`;
            let existing = toolchainMap.get(key);

            if (!existing) {
                existing = { id: toolchain.id, version: toolchain.version, systems: [] };
                toolchainMap.set(key, existing);
            }

            // Merge systems, avoiding duplicates
            for (const system of toolchain.systems ?? []) {
                const existingSystem = existing.systems.find(s => s.host === system.host);
                if (!existingSystem) {
                    existing.systems.push(system);
                } else {
                    // Update existing system with new data
                    Object.assign(existingSystem, system);
                }
            }
        }
    }

    // Convert map back to array and sort
    const merged = Array.from(toolchainMap.values());
    merged.sort((a, b) => {
        const idCompare = a.id.localeCompare(b.id);
        if (idCompare !== 0) return idCompare;
        return b.version.localeCompare(a.version); // Descending version
    });

    // Sort systems within each toolchain
    for (const toolchain of merged) {
        toolchain.systems?.sort((a, b) => a.host.localeCompare(b.host));
    }

    return merged;
};

/**
 * Main function
 * @param {string} artifactsDir - Path to artifacts directory
 */
const main = async (artifactsDir) => {
    logger.section('Merging packages.json files');

    if (!artifactsDir) {
        throw new Error('Artifacts directory not specified');
    }

    // Read base packages.json
    const basePackagesJson = await readLocalPackagesJson();
    logger.info(`Base toolchains: ${getToolchains(basePackagesJson).length}`);

    // Read all artifacts
    const artifacts = await readArtifacts(artifactsDir);
    logger.info(`Found ${artifacts.length} artifact(s)`);

    if (artifacts.length === 0) {
        logger.warn('No artifacts found, nothing to merge');
        return;
    }

    // Merge toolchains
    const mergedToolchains = mergeToolchains(basePackagesJson, artifacts);
    logger.info(`Merged toolchains: ${mergedToolchains.length}`);

    // Write updated packages.json
    const updated = updateToolchains(basePackagesJson, mergedToolchains);
    await writePackagesJson(updated);

    logger.success('Merge complete');
};

// Run if executed directly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
    const artifactsDir = process.argv[2];
    main(artifactsDir).catch(err => {
        logger.error(err.message);
        process.exit(1);
    });
}

export default { mergeToolchains };

