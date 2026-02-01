#!/usr/bin/env node

/**
 * PR Validation Script
 * Validates changes to registry.json and toolchains.json in pull requests
 */

import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';
import {validateRegistry} from './registry-validator.js';
import {validateToolchains} from './toolchains-validator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse command line arguments
 * @returns {object} Parsed arguments
 */
const parseArgs = () => {
    const args = process.argv.slice(2);
    const options = {};

    for (const arg of args) {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=');
            options[key.replace(/-/g, '_')] = value;
        }
    }

    return options;
};

/**
 * Read JSON file safely
 * @param {string} filePath - Path to JSON file
 * @returns {Promise<object|null>} Parsed JSON or null if not exists
 */
const readJsonFile = async (filePath) => {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
};

/**
 * Generate markdown report
 * @param {object} results - Validation results
 * @returns {string} Markdown report
 */
const generateReport = (results) => {
    const {registry, toolchains} = results;
    const hasErrors = registry.errors.length > 0 || toolchains.errors.length > 0;

    const lines = [];

    if (hasErrors) {
        lines.push('## ❌ PR Validation Failed');
    } else {
        lines.push('## ✅ PR Validation Passed');
    }
    lines.push('');

    // Registry section
    if (registry.checked) {
        lines.push('### registry.json');
        lines.push('');

        if (registry.errors.length > 0) {
            lines.push('#### Errors');
            lines.push('');
            for (const error of registry.errors) {
                lines.push(`- ❌ ${error}`);
            }
            lines.push('');
        }

        if (registry.added.length > 0) {
            lines.push('#### New Entries');
            lines.push('');
            lines.push('| Type | Repository | Status |');
            lines.push('| ---- | ---------- | ------ |');
            for (const item of registry.added) {
                const status = item.valid ? '✅ Valid' : `❌ ${item.error}`;
                lines.push(`| ${item.type} | ${item.repo} | ${status} |`);
            }
            lines.push('');
        } else if (registry.errors.length === 0) {
            lines.push('No new entries added.');
            lines.push('');
        }
    }

    // Toolchains section
    if (toolchains.checked) {
        lines.push('### toolchains.json');
        lines.push('');

        if (toolchains.errors.length > 0) {
            lines.push('#### Errors');
            lines.push('');
            for (const error of toolchains.errors) {
                lines.push(`- ❌ ${error}`);
            }
            lines.push('');
        }

        if (toolchains.added.length > 0) {
            lines.push('#### New Entries');
            lines.push('');
            lines.push('| ID | Core | Status |');
            lines.push('| -- | ---- | ------ |');
            for (const item of toolchains.added) {
                const status = item.valid ? '✅ Valid' : `❌ ${item.error}`;
                lines.push(`| ${item.id} | ${item.core} | ${status} |`);
            }
            lines.push('');
        } else if (toolchains.errors.length === 0) {
            lines.push('No new entries added.');
            lines.push('');
        }
    }

    return lines.join('\n');
};

/**
 * Main function
 */
const main = async () => {
    const options = parseArgs();

    const prRegistry = await readJsonFile(options.pr_registry);
    const prToolchains = await readJsonFile(options.pr_toolchains);
    const baseRegistry = await readJsonFile(options.base_registry);
    const baseToolchains = await readJsonFile(options.base_toolchains);

    const results = {
        registry: {checked: false, errors: [], added: []},
        toolchains: {checked: false, errors: [], added: []}
    };

    // Validate registry.json if it exists in PR
    if (prRegistry) {
        results.registry = await validateRegistry(prRegistry, baseRegistry);
    }

    // Validate toolchains.json if it exists in PR
    if (prToolchains) {
        results.toolchains = await validateToolchains(prToolchains, baseToolchains);
    }

    // Generate report
    const report = generateReport(results);
    console.log(report);

    // Write report to file if output specified
    if (options.output) {
        const outputPath = path.resolve(process.cwd(), options.output);
        await fs.writeFile(outputPath, report, 'utf-8');
    }
};

main().catch(err => {
    console.error('Validation error:', err.message);
    process.exit(1);
});
