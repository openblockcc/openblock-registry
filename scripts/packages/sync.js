#!/usr/bin/env node

/**
 * Main sync script for OpenBlock Registry packages
 * Syncs devices and extensions from registry.json to R2 storage
 *
 * The pipeline runs in two phases that map onto two separate CI jobs:
 *   - build  (--phase=build):  clone + validate + build untrusted plugins into
 *                              a local artifact directory. Holds NO R2 credentials,
 *                              so plugin code that executes during build has nothing
 *                              to steal. Reads only public data (GitHub, public
 *                              packages.json).
 *   - upload (--phase=upload): consume the build artifact and push to R2. Holds the
 *                              R2 credentials but never executes plugin code.
 * Running with no --phase performs both phases in-process (for local/manual use).
 */

import {fileURLToPath} from 'url';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import logger from '../common/logger.js';
import {readRegistryJson, parseRepoUrl, isValidSemver, compareSemver, calculateDiff, getPackageVersions} from './calculate-diff.js';
import {fetchTags, fetchPackageJson, findOpenIssueByMarker, createIssue} from './github/api.js';
import {createZipArchive} from './github/downloader.js';
import {processVersion} from './plugin-processor.js';
import {
    fetchTranslationsFromR2,
    uploadTranslationsToR2,
    initTranslationsDir,
    mergePluginTranslations,
    pushToTransifex
} from './translation-merger.js';
import {uploadBuffer, uploadFile, uploadJson} from '../common/r2-client.js';
import {
    fetchRemotePackagesJsonOrThrow,
    createEmptyPackagesJson,
    mergePackagesSections,
    getDevices,
    getExtensions,
    addPackageVersion,
    applyRecommendedFlags
} from '../common/packages-json.js';
import {extractDisplay, hashIconBytes, computeDisplayHash} from '../common/display-manifest.js';
import {readApprovedManifest} from '../common/approved-store.js';
import {enforceDisplay, DISPLAY_ENTRY_FIELDS} from './display-enforcement.js';
import {LIMITS} from '../common/limits.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// MIME type map for image uploads
const IMAGE_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
};

// Icon field name → R2 file stem mapping
const ICON_FIELDS = {
    iconURL: 'icon',
    connectionIconURL: 'connectionIcon',
    connectionSmallIconURL: 'connectionSmallIcon'
};

/**
 * Upload plugin icon files to R2 and return a map of field → R2 URL.
 * Skips fields that are already remote URLs.
 * @param {object} openblock - openblock section of dist/package.json
 * @param {string} type - Package type ('devices' or 'extensions')
 * @param {string} id - Package ID
 * @param {string} distPath - Path to the directory holding the icon files (build dist or staged artifact)
 * @returns {Promise<object>} Map of icon field names to R2 URLs
 */
const uploadPluginIcons = async (openblock, type, id, distPath) => {
    const updates = {};

    for (const [field, stem] of Object.entries(ICON_FIELDS)) {
        const iconRelPath = openblock[field];
        if (!iconRelPath || iconRelPath.startsWith('http://') || iconRelPath.startsWith('https://')) {
            continue;
        }

        const localPath = path.resolve(distPath, iconRelPath);
        try {
            await fs.access(localPath);
        } catch {
            logger.warn(`Icon file not found, skipping: ${localPath}`);
            continue;
        }

        const ext = path.extname(localPath).toLowerCase();
        const contentType = IMAGE_MIME_TYPES[ext] || 'application/octet-stream';
        const remotePath = `${type}/${id}/${stem}${ext}`;

        const buffer = await fs.readFile(localPath);
        const uploadResult = await uploadBuffer(buffer, remotePath, contentType);
        updates[field] = uploadResult.url;
    }

    return updates;
};

// Configuration
const DEFAULT_CONCURRENCY = 3;
const TEMP_DIR_PREFIX = 'openblock-sync-';
const GLOBAL_TRANSLATIONS_DIR = path.resolve(__dirname, '../../.translations');
// Build artifact handoff between the build and upload phases
const BUILD_RESULT_FILENAME = 'build-result.json';

/**
 * Run tasks with concurrency limit
 * @param {Array} items - Items to process
 * @param {Function} handler - Handler function for each item
 * @param {number} concurrency - Max concurrent tasks
 * @returns {Promise<Array>} Results array
 */
const runWithConcurrency = async (items, handler, concurrency) => {
    const results = [];
    const executing = [];

    for (const item of items) {
        const promise = handler(item).then(result => {
            executing.splice(executing.indexOf(promise), 1);
            return result;
        });

        results.push(promise);
        executing.push(promise);

        if (executing.length >= concurrency) {
            await Promise.race(executing);
        }
    }

    return Promise.all(results);
};

/**
 * Build package entry for packages.json
 * Uses the compiled dist/package.json which contains base64 iconURL and processed fields
 * @param {object} distPackageJson - Compiled package.json from dist directory
 * @param {string} type - Package type ('devices' or 'extensions')
 * @param {string} version - Version string
 * @param {string} repoUrl - Repository URL
 * @param {object} fileInfo - File information (url, checksum, size)
 * @returns {object} Package entry for packages.json
 */
const buildPackageEntry = (distPackageJson, type, version, repoUrl, fileInfo) => {
    const openblock = distPackageJson.openblock || {};
    const idField = type === 'devices' ? 'deviceId' : 'extensionId';
    const id = openblock[idField];

    // Start with the id and version
    const entry = {
        [idField]: id,
        version
    };

    // Copy all openblock fields directly from dist/package.json
    // This includes base64 iconURL, i18n formatted name/description, etc.
    const openblockFields = [
        'name',
        'description',
        'iconURL',
        'helpLink',
        'tags',
        'l10n'
    ];

    // Device-specific fields
    const deviceFields = [
        'manufactor',
        'learnMore',
        'type',
        'arch',
        'programMode',
        'extensions',
        'bluetoothRequired',
        'serialportRequired',
        'internetConnectionRequired',
        'toolchains'
    ];

    // Extension-specific fields
    const extensionFields = [
        'arch'
    ];

    // Copy common fields
    for (const field of openblockFields) {
        if (Object.prototype.hasOwnProperty.call(openblock, field)) {
            entry[field] = openblock[field];
        }
    }

    // Copy type-specific fields
    const typeFields = type === 'devices' ? deviceFields : extensionFields;
    for (const field of typeFields) {
        if (Object.prototype.hasOwnProperty.call(openblock, field)) {
            entry[field] = openblock[field];
        }
    }

    // Add author from package.json root
    if (distPackageJson.author) {
        entry.author = distPackageJson.author;
    }

    // Add repository URL
    entry.repository = repoUrl;

    // Add file information
    entry.url = fileInfo.url;
    entry.archiveFileName = fileInfo.archiveFileName;
    entry.checksum = `SHA-256:${fileInfo.checksum}`;
    entry.size = fileInfo.size.toString();

    return entry;
};

/**
 * Stage a built plugin version into the artifact directory.
 *
 * Writes everything the upload phase needs to publish without re-running any
 * plugin code: the final zip (with deterministic checksum/size), the compiled
 * dist/package.json, the local icon files (at their relative paths so they can be
 * uploaded later), and the extracted translations.
 *
 * @param {object} options - Staging options
 * @param {string} options.type - Package type ('devices' or 'extensions')
 * @param {string} options.id - Package ID
 * @param {string} options.version - Version string
 * @param {string} options.repoUrl - Repository URL
 * @param {string} options.distPath - Built dist directory
 * @param {string} [options.translationsPath] - Extracted .translations directory, if any
 * @param {string} options.artifactDir - Root artifact directory
 * @returns {Promise<object>} Serializable build record
 */
const stageVersionArtifact = async ({type, id, version, repoUrl, sourcePath, distPath, translationsPath, artifactDir}) => {
    const relDir = path.posix.join(type, id, version);
    const versionDir = path.join(artifactDir, type, id, version);
    await fs.mkdir(versionDir, {recursive: true});

    // Compiled package.json drives entry building and tells us which icons are local.
    const distPackageJsonPath = path.join(distPath, 'package.json');
    const distPackageJson = JSON.parse(await fs.readFile(distPackageJsonPath, 'utf-8'));
    await fs.copyFile(distPackageJsonPath, path.join(versionDir, 'package.json'));

    // Copy the built (possibly compressed) icon files into the artifact so the
    // upload phase can push them to R2 with uploadPluginIcons.
    const openblock = distPackageJson.openblock || {};
    const icons = {};
    for (const field of Object.keys(ICON_FIELDS)) {
        const rel = openblock[field];
        if (!rel || rel.startsWith('http://') || rel.startsWith('https://')) {
            continue;
        }
        const distSrc = path.resolve(distPath, rel);
        let bytes;
        try {
            bytes = await fs.readFile(distSrc);
        } catch {
            continue;
        }
        const dest = path.resolve(versionDir, rel);
        await fs.mkdir(path.dirname(dest), {recursive: true});
        await fs.writeFile(dest, bytes);
        icons[field] = rel;
    }

    // Hash the SOURCE icon bytes (pre-build, straight from the cloned repo) — not
    // the dist bytes. The build may re-encode large icons via sharp, whose output
    // is not byte-deterministic across platforms, so dist bytes could never agree
    // with what the PR bot and CLI hash. The source bytes are the stable, in-git
    // artifact all three consumers can reproduce. (§5.10)
    const iconHashes = {};
    for (const field of Object.keys(ICON_FIELDS)) {
        const rel = openblock[field];
        if (!rel || rel.startsWith('http://') || rel.startsWith('https://')) {
            continue;
        }
        try {
            iconHashes[field] = hashIconBytes(await fs.readFile(path.resolve(sourcePath, rel.replace(/^\.\//, ''))));
        } catch {
            // Source icon unreadable: omit from the hash, matching how the bot and
            // CLI skip unhashable icons, so the three stay consistent.
        }
    }

    // Freeze the display fingerprint. Text fields are not transformed by the
    // build, so reading them from the compiled manifest matches the source.
    const display = extractDisplay(distPackageJson);
    const displayHash = computeDisplayHash(display, iconHashes);

    // Build the final zip now so its bytes (and thus checksum/size) are frozen
    // before the artifact crosses the job boundary.
    const archiveFileName = `${id}-${version}.zip`;
    const zipResult = await createZipArchive(distPath, path.join(versionDir, 'plugin.zip'));

    // Cap the published package size (R2.3): reject oversized artifacts before
    // they cross the job boundary / land on R2.
    if (zipResult.size > LIMITS.maxZipBytes) {
        throw new Error(`Package size ${zipResult.size} exceeds limit ${LIMITS.maxZipBytes}`);
    }

    // Copy extracted translations, if any, for the upload phase to merge into R2.
    let hasTranslations = false;
    if (translationsPath) {
        try {
            await fs.cp(translationsPath, path.join(versionDir, '.translations'), {recursive: true});
            hasTranslations = true;
        } catch {
            hasTranslations = false;
        }
    }

    return {
        type,
        id,
        version,
        repoUrl,
        dir: relDir,
        archiveFileName,
        checksum: zipResult.checksum,
        size: zipResult.size,
        icons,
        iconHashes,
        displayHash,
        hasTranslations
    };
};

/**
 * Build a single version (download, validate, build, extract) and stage it.
 * Performs no R2 access.
 * @param {object} options - Build options (type, owner, repo, id, version, repoUrl, tempDir, artifactDir)
 * @returns {Promise<object>} Result with success and either record or error
 */
const buildVersion = async ({type, owner, repo, id, version, repoUrl, tempDir, artifactDir}) => {
    const processResult = await processVersion({owner, repo, tag: version, type, tempDir});
    if (!processResult.success) {
        return {success: false, error: processResult.error};
    }

    const {extractedPath, distPath, translationsPath, cleanup} = processResult.data;
    try {
        const record = await stageVersionArtifact({
            type, id, version, repoUrl, sourcePath: extractedPath, distPath, translationsPath, artifactDir
        });
        return {success: true, record};
    } catch (err) {
        return {success: false, error: err.message};
    } finally {
        await cleanup();
    }
};

/**
 * Find the existing top-level package entry for an id in packages.json. Used as
 * the source of previously-approved display fields when overriding a drifted
 * version (the live entry already holds them in publishable shape).
 * @param {object} packagesJson - Packages.json being assembled
 * @param {string} type - 'devices' or 'extensions'
 * @param {string} id - Plugin id
 * @returns {object|null} Existing package object or null
 */
const findCurrentEntry = (packagesJson, type, id) => {
    const list = type === 'devices' ? getDevices(packagesJson) : getExtensions(packagesJson);
    const idField = type === 'devices' ? 'deviceId' : 'extensionId';
    return list.find(p => p[idField] === id) || null;
};

/**
 * Force-rebuild the newest tag of a plugin whose overridden display can now be
 * promoted (§5.8). The freeze is only re-evaluated when a version is rebuilt, so
 * a baseline PR merged *after* a drifted version was synced would otherwise never
 * take effect. The rebuild is gated on the committed baseline having actually
 * caught up — i.e. the drifted version's stored hash now equals the approved
 * displayHash — so we rebuild exactly once at promotion, not every sync while the
 * baseline is still unmerged.
 * @param {string[]} toAdd - Versions already scheduled to build (newest-first)
 * @param {string[]} toSkip - Versions scheduled to skip
 * @param {string[]} validTagNames - All valid semver tag names for the repo
 * @param {object|null} currentEntry - Existing published entry for this id
 * @param {string|undefined} approvedDisplayHash - displayHash of the committed approved baseline
 * @returns {object} New {toAdd, toSkip, reconciledTag} (reconciledTag null if no-op)
 */
const planReconciliation = (toAdd, toSkip, validTagNames, currentEntry, approvedDisplayHash) => {
    if (!currentEntry || !currentEntry.displayOverridden) {
        return {toAdd, toSkip, reconciledTag: null};
    }
    // Only rebuild once the baseline matches the drifted version that was pinned
    // at override time. Otherwise rebuilding would just re-derive the same drift
    // and override again — pure waste.
    if (!approvedDisplayHash || currentEntry.pendingDisplayHash !== approvedDisplayHash) {
        return {toAdd, toSkip, reconciledTag: null};
    }
    const latestTag = [...validTagNames].sort((a, b) => -compareSemver(a, b))[0];
    if (!latestTag || toAdd.includes(latestTag)) {
        return {toAdd, toSkip, reconciledTag: null};
    }
    return {
        toAdd: [latestTag, ...toAdd],
        toSkip: toSkip.filter(v => v !== latestTag),
        reconciledTag: latestTag
    };
};

/**
 * Replace the display fields of a freshly-built entry with the approved values
 * carried by the existing published entry (strategy b). Drifted display data is
 * discarded; code/version/download fields on `entry` are kept.
 * @param {object} entry - Newly built package entry
 * @param {object} currentEntry - Existing (approved) published entry
 * @returns {object} Entry with display fields forced to the approved baseline
 */
const applyApprovedDisplay = (entry, currentEntry) => {
    const result = {...entry};
    for (const field of DISPLAY_ENTRY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(currentEntry, field)) {
            result[field] = currentEntry[field];
        } else {
            delete result[field];
        }
    }
    return result;
};

/**
 * Publish a staged version to R2: upload icons + zip, merge translations, and add
 * the entry to packages.json. Executes no plugin code.
 *
 * Enforces the display freeze (§5.7/§5.8) before writing the entry: asserts the
 * repo→id binding (R3.1) and, on display drift, forces the display back to the
 * approved baseline (strategy b) instead of publishing the drifted values.
 * @param {object} record - Build record produced by stageVersionArtifact
 * @param {string} artifactDir - Root artifact directory
 * @param {object} currentPackages - Packages.json being assembled
 * @param {object} globalTranslations - Global translations from R2 (mutated in place)
 * @returns {Promise<object>} Result with currentPackages and url
 */
const publishVersion = async (record, artifactDir, currentPackages, globalTranslations) => {
    const {type, id, version, repoUrl, dir, archiveFileName, checksum, size, hasTranslations, displayHash} = record;
    const versionDir = path.join(artifactDir, dir);

    // Read the staged compiled package.json
    const distPackageJson = JSON.parse(
        await fs.readFile(path.join(versionDir, 'package.json'), 'utf-8')
    );

    // Display-freeze decision against the committed baseline (trusted, in-repo).
    const approved = await readApprovedManifest(id);
    const currentEntry = findCurrentEntry(currentPackages, type, id);
    const decision = enforceDisplay({
        id,
        repoUrl,
        approved,
        incomingDisplayHash: displayHash,
        hasCurrentEntry: Boolean(currentEntry)
    });

    // A rejected version is not published; the caller records it as an error.
    if (decision.action === 'reject') {
        throw new Error(decision.reason);
    }
    const override = decision.action === 'override';
    if (decision.reason) {
        logger.warn(`${id}@${version}: ${decision.reason}`);
    }

    // Upload local icons (rewriting to R2 URLs) only when serving the new
    // display. On override the approved display+icons are reused from the live
    // entry, so the drifted icons are never uploaded.
    if (!override) {
        const iconUpdates = await uploadPluginIcons(distPackageJson.openblock || {}, type, id, versionDir);
        if (Object.keys(iconUpdates).length > 0) {
            distPackageJson.openblock = {...(distPackageJson.openblock || {}), ...iconUpdates};
        }
    }

    // Upload the prebuilt zip (code always flows, regardless of display drift)
    const remotePath = `${type}/${id}/${version}.zip`;
    const uploadResult = await uploadFile(path.join(versionDir, 'plugin.zip'), remotePath);

    // Merge translations (mutates globalTranslations)
    if (hasTranslations && globalTranslations) {
        await mergePluginTranslations(path.join(versionDir, '.translations'), globalTranslations, id);
    }

    // Build entry using the deterministic checksum/size frozen at build time
    let packageEntry = buildPackageEntry(distPackageJson, type, version, repoUrl, {
        url: uploadResult.url,
        archiveFileName,
        checksum,
        size
    });

    if (override) {
        packageEntry = applyApprovedDisplay(packageEntry, currentEntry);
        packageEntry.displayOverridden = true;
        // Remember the drifted version's hash (not its content). Reconciliation
        // compares it to the committed baseline to know — without rebuilding —
        // whether the baseline has caught up and a promotion is now possible.
        packageEntry.pendingDisplayHash = displayHash;
    } else if (decision.pendingReview) {
        packageEntry.displayPendingReview = true;
    }

    return {
        currentPackages: addPackageVersion(currentPackages, type, packageEntry),
        url: uploadResult.url,
        size
    };
};

/**
 * Build (download + compile) every new version of one repository into the artifact
 * directory. No R2 access; reads only public data.
 * @param {string} type - Package type (devices/extensions)
 * @param {string} repoUrl - Repository URL
 * @param {object} currentPackages - Current packages.json (read-only, for diffing)
 * @param {string} tempDir - Temporary directory for clones
 * @param {object} options - Processing options
 * @param {string} artifactDir - Root artifact directory
 * @returns {Promise<object>} Result with built, skipped and errors arrays
 */
const buildRepository = async (type, repoUrl, currentPackages, tempDir, options, artifactDir) => {
    const {owner, repo} = parseRepoUrl(repoUrl);
    const built = [];
    const skipped = [];
    const errors = [];

    logger.info(`Processing ${type}: ${owner}/${repo}`);

    try {
        // Fetch tags from GitHub
        const tags = await fetchTags(owner, repo);
        const validTags = tags.filter(tag => isValidSemver(tag.name));

        if (validTags.length === 0) {
            logger.warn(`No valid semantic version tags found in ${owner}/${repo}`);
            return {built, skipped, errors};
        }

        logger.info(`Found ${validTags.length} valid version(s) in ${owner}/${repo}`);

        // Fetch package.json from the first tag to resolve the package ID
        const firstTag = validTags[0].name;
        const firstPackageJson = await fetchPackageJson(owner, repo, firstTag);
        const id = type === 'devices' ?
            firstPackageJson.openblock?.deviceId :
            firstPackageJson.openblock?.extensionId;

        if (!id) {
            const error = `Missing ${type === 'devices' ? 'deviceId' : 'extensionId'} in package.json`;
            errors.push({type, repo: `${owner}/${repo}`, version: firstTag, error});
            return {built, skipped, errors};
        }

        const currentVersions = getPackageVersions(
            type === 'devices' ? getDevices(currentPackages) : getExtensions(currentPackages),
            id
        );

        // Calculate diff
        let {toAdd, toSkip} = calculateDiff(validTags, currentVersions);

        // Display reconciliation (§5.8): re-check the freeze on an already-synced
        // version whose display is still overridden, but only once the committed
        // baseline has caught up (cheap local read of approved/{id}.json — no
        // rebuild while the baseline PR is still unmerged). See planReconciliation.
        const currentEntry = findCurrentEntry(currentPackages, type, id);
        if (!options.rebuild && currentEntry && currentEntry.displayOverridden) {
            const approved = await readApprovedManifest(id);
            const recon = planReconciliation(
                toAdd, toSkip, validTags.map(tag => tag.name), currentEntry, approved?.displayHash
            );
            if (recon.reconciledTag) {
                logger.info(`${owner}/${repo}: baseline caught up, promoting display on ${recon.reconciledTag}`);
            }
            toAdd = recon.toAdd;
            toSkip = recon.toSkip;
        }

        // Cap new versions built per repo per run (R2.3): keep the newest N
        // (toAdd is newest-first), drop older ones so a repo with thousands of
        // tags can't exhaust the runner.
        if (toAdd.length > LIMITS.maxNewVersionsPerRepo) {
            const dropped = toAdd.slice(LIMITS.maxNewVersionsPerRepo);
            toAdd = toAdd.slice(0, LIMITS.maxNewVersionsPerRepo);
            logger.warn(`${owner}/${repo}: ${dropped.length} version(s) over the per-repo cap ` +
                `(${LIMITS.maxNewVersionsPerRepo}) skipped this run`);
        }

        logger.info(`${owner}/${repo}: ${toAdd.length} to add, ${toSkip.length} to skip`);

        // Skip versions (only if not rebuilding)
        if (!options.rebuild) {
            skipped.push(...toSkip.map(v => ({
                type,
                id,
                repo: `${owner}/${repo}`,
                version: v
            })));
        }

        // Build versions to add
        for (const version of toAdd) {
            if (options.dryRun) {
                logger.info(`[DRY RUN] Would process ${owner}/${repo}@${version}`);
                built.push({
                    type,
                    id,
                    repo: `${owner}/${repo}`,
                    version,
                    dryRun: true
                });
                continue;
            }

            logger.info(`Building version ${owner}/${repo}@${version}...`);
            const result = await buildVersion({type, owner, repo, id, version, repoUrl, tempDir, artifactDir});
            if (!result.success) {
                errors.push({
                    type,
                    repo: `${owner}/${repo}`,
                    version,
                    error: result.error
                });
                continue;
            }

            built.push(result.record);
            logger.success(`Built ${owner}/${repo}@${version}`);
        }

        return {built, skipped, errors};

    } catch (err) {
        logger.error(`Failed to process ${owner}/${repo}: ${err.message}`);
        errors.push({repo: `${owner}/${repo}`, version: 'N/A', error: err.message});
        return {built, skipped, errors};
    }
};

/**
 * Generate sync report in Markdown format
 * @param {object} results - Sync results
 * @returns {string} Markdown report
 */
const generateReport = (results) => {
    const {added, skipped, errors, repositoryStats, dryRun} = results;

    let report = '## Package Sync Report\n\n';

    if (dryRun) {
        report += '> **Dry Run** - No changes were made\n\n';
    }

    // Summary
    report += '### Summary\n\n';
    report += '| Added | Skipped | Failed |\n';
    report += '|:-----:|:-------:|:------:|\n';
    report += `| ${added.length} | ${skipped.length} | ${errors.length} |\n\n`;

    // Added
    if (added.length > 0) {
        report += '### Added\n\n';
        report += '| Type | ID | Version | Size | Repository |\n';
        report += '|------|-----|---------|-----:|------------|\n';
        added.forEach(item => {
            const sizeLabel = typeof item.size === 'number' ? `${(item.size / 1024).toFixed(1)} KB` : '—';
            const typeLabel = item.type === 'devices' ? 'device' : 'extension';
            report += `| ${typeLabel} | ${item.id} | ${item.version} | ${sizeLabel} | ${item.repo} |\n`;
        });
        report += '\n';
    }

    // Skipped
    if (skipped.length > 0) {
        report += '### Skipped (Already Exists)\n\n';
        report += '| Type | ID | Version |\n';
        report += '|------|-----|---------|\n';
        skipped.forEach(item => {
            const typeLabel = item.type === 'devices' ? 'device' : 'extension';
            report += `| ${typeLabel} | ${item.id} | ${item.version} |\n`;
        });
        report += '\n';
    }

    // Errors
    if (errors.length > 0) {
        report += '### Failed\n\n';
        report += '| Type | Repository | Version | Error |\n';
        report += '|------|------------|---------|-------|\n';
        errors.forEach(item => {
            const typeLabel = item.type === 'devices' ? 'device' : 'extension';
            report += `| ${typeLabel} | ${item.repo} | ${item.version} | ${item.error} |\n`;
        });
        report += '\n';
    }

    // Repository Status
    if (repositoryStats && repositoryStats.length > 0) {
        report += '### Repository Status\n\n';
        report += '| Repository | Tags Found | Added | Skipped | Failed |\n';
        report += '|------------|:----------:|:-----:|:-------:|:------:|\n';
        repositoryStats.forEach(stat => {
            report += `| ${stat.repo} | ${stat.tagsFound} | ${stat.added} | ${stat.skipped} | ${stat.failed} |\n`;
        });
        report += '\n';
    }

    return report;
};

/**
 * Create issues for failed syncs
 * @param {Array} errors - Error list
 * @param {string} workflowRunUrl - GitHub workflow run URL
 */
const createErrorIssues = async (errors, workflowRunUrl) => {
    logger.section('Creating Issues for Errors');

    for (const error of errors) {
        try {
            const {owner, repo} = parseRepoUrl(`https://github.com/${error.repo}`);

            // Stable dedup key: one open issue per repo@version failure. Kept in a
            // hidden HTML comment so re-runs of the same unfixed failure find the
            // existing issue instead of filing a duplicate every day. The key omits
            // the error text on purpose, so a reworded error for the same version
            // is still treated as the same problem.
            const marker = `<!-- openblock-registry-sync-error: ${error.repo}@${error.version} -->`;

            const existing = await findOpenIssueByMarker(owner, repo, marker);
            if (existing) {
                logger.info(`Sync-error issue already open for ${error.repo}@${error.version} (#${existing.number}), skipping`);
                continue;
            }

            const title = `[OpenBlock Registry] Sync failed for version ${error.version}`;
            const body = `${marker}
## ❌ OpenBlock Registry Sync Failed

The automatic sync process encountered an error while processing this repository.

### Error Details

| Field | Value |
|-------|-------|
| **Version** | ${error.version} |
| **Error** | ${error.error} |
| **Timestamp** | ${new Date().toISOString()} |

### Workflow Run

🔗 [View workflow run](${workflowRunUrl || 'N/A'})

### Next Steps

Please check the error message above and verify your repository configuration. If you believe this is a bug in the sync process, please report it at:
https://github.com/openblockcc/openblock-registry/issues

---
*This issue was automatically created by OpenBlock Registry sync workflow.*`;

            await createIssue(owner, repo, title, body);
            logger.success(`Created issue in ${owner}/${repo}`);

        } catch (err) {
            logger.warn(`Failed to create issue for ${error.repo}: ${err.message}`);
        }
    }
};

/**
 * Collect per-repository stats from build results.
 * @param {string} repoUrl - Repository URL
 * @param {object} result - buildRepository result ({built, skipped, errors})
 * @returns {object} Repository stat row
 */
const repoStatFromResult = (repoUrl, result) => {
    const {owner, repo} = parseRepoUrl(repoUrl);
    const tagsFound = result.built.length + result.skipped.length + result.errors.length;
    return {
        repo: `${owner}/${repo}`,
        tagsFound,
        added: result.built.length,
        skipped: result.skipped.length,
        failed: result.errors.length
    };
};

/**
 * Read the current packages.json baseline from the public registry.
 * Used for diffing/merging; requires no R2 credentials.
 * @param {boolean} dryRun - Whether this is a dry run (tolerate fetch failure)
 * @returns {Promise<object>} Baseline packages.json
 */
const fetchBaselinePackages = async (dryRun) => {
    try {
        return await fetchRemotePackagesJsonOrThrow();
    } catch (err) {
        if (dryRun) {
            logger.warn(`Failed to fetch remote packages.json in dry-run: ${err.message}`);
            return createEmptyPackagesJson();
        }
        throw err;
    }
};

/**
 * Build phase: clone + validate + build every new version into the artifact
 * directory and write a build-result.json manifest. Performs NO R2 writes.
 * @param {object} options - Sync options
 * @param {string} artifactDir - Root artifact directory
 * @returns {Promise<object>} Build results ({built, skipped, errors, repositoryStats})
 */
export const syncBuild = async (options, artifactDir) => {
    const {dryRun = false, rebuild = false} = options;

    logger.section('Build Phase');
    if (dryRun) {
        logger.warn('DRY RUN MODE - No artifacts will be produced');
    }
    if (rebuild) {
        logger.warn('REBUILD MODE - Building all versions from source');
    }

    await fs.mkdir(artifactDir, {recursive: true});

    const allBuilt = [];
    const allSkipped = [];
    const allErrors = [];
    const repositoryStats = [];

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
    logger.info(`Temporary directory: ${tempDir}`);

    try {
        logger.section('Reading Configuration');
        const registry = await readRegistryJson();
        logger.info(`Devices: ${registry.devices.length}`);
        logger.info(`Extensions: ${registry.extensions.length}`);

        // Public read of the current packages.json, only used to compute the diff.
        const baseRemotePackages = await fetchBaselinePackages(dryRun);
        const currentPackages = rebuild ? createEmptyPackagesJson() : baseRemotePackages;
        logger.info(`Current devices: ${getDevices(currentPackages).length}`);
        logger.info(`Current extensions: ${getExtensions(currentPackages).length}`);

        const sections = [
            {type: 'devices', repos: registry.devices, label: 'Devices'},
            {type: 'extensions', repos: registry.extensions, label: 'Extensions'}
        ];

        for (const {type, repos, label} of sections) {
            logger.section(`Building ${label}`);
            for (const repoUrl of repos) {
                const result = await buildRepository(type, repoUrl, currentPackages, tempDir, options, artifactDir);
                allBuilt.push(...result.built);
                allSkipped.push(...result.skipped);
                allErrors.push(...result.errors);
                repositoryStats.push(repoStatFromResult(repoUrl, result));
            }
        }
    } finally {
        await fs.rm(tempDir, {recursive: true, force: true}).catch(() => {});
    }

    const buildResult = {
        dryRun,
        rebuild,
        skipTransifex: options.skipTransifex || false,
        built: allBuilt,
        skipped: allSkipped,
        errors: allErrors,
        repositoryStats
    };

    // Persist the manifest so the upload job (or upload phase) can consume it.
    await fs.writeFile(
        path.join(artifactDir, BUILD_RESULT_FILENAME),
        JSON.stringify(buildResult, null, 2),
        'utf-8'
    );

    logger.success(`Build phase complete: ${allBuilt.length} built, ${allSkipped.length} skipped, ${allErrors.length} failed`);

    // In dry-run there is no upload phase, so emit the report here.
    if (dryRun) {
        console.log(generateReport({
            added: allBuilt,
            skipped: allSkipped,
            errors: allErrors,
            repositoryStats,
            dryRun
        }));
    }

    return buildResult;
};

/**
 * Upload phase: consume a build artifact and publish to R2. Holds R2 credentials
 * but executes no plugin code.
 * @param {object} options - Sync options
 * @param {string} artifactDir - Root artifact directory produced by the build phase
 * @returns {Promise<void>} Resolves when the upload phase completes
 */
export const syncUpload = async (options, artifactDir) => {
    const {skipTransifex = false} = options;

    logger.section('Upload Phase');

    const buildResultPath = path.join(artifactDir, BUILD_RESULT_FILENAME);
    let buildResult;
    try {
        buildResult = JSON.parse(await fs.readFile(buildResultPath, 'utf-8'));
    } catch (err) {
        throw new Error(`Failed to read build result at ${buildResultPath}: ${err.message}`);
    }

    if (buildResult.dryRun) {
        logger.warn('Build artifact was produced in dry-run mode; nothing to upload');
        return;
    }

    const {built, skipped, errors, repositoryStats, rebuild} = buildResult;
    const uploadErrors = [...errors];

    // Registry.json is committed/trusted; reread it for the recommended allowlist.
    logger.section('Reading Configuration');
    const registry = await readRegistryJson();
    const recommendedAllowlist = {
        devices: new Set(registry.recommended.devices),
        extensions: new Set(registry.recommended.extensions)
    };
    logger.info(`Recommended: ${recommendedAllowlist.devices.size} device(s), ${recommendedAllowlist.extensions.size} extension(s)`);

    // Baseline packages.json (public read), used as the merge target.
    const baseRemotePackages = await fetchBaselinePackages(false);
    let currentPackages = rebuild ? createEmptyPackagesJson() : baseRemotePackages;

    // Existing translations from R2 (public read; written back below with credentials).
    const globalTranslations = await fetchTranslationsFromR2();

    const added = [];

    logger.section('Publishing Versions');
    for (const record of built) {
        try {
            const result = await publishVersion(record, artifactDir, currentPackages, globalTranslations);
            currentPackages = result.currentPackages;
            const {owner, repo} = parseRepoUrl(record.repoUrl);
            added.push({
                type: record.type,
                id: record.id,
                repo: `${owner}/${repo}`,
                version: record.version,
                size: result.size,
                url: result.url
            });
            logger.success(`Published ${record.id}@${record.version}`);
        } catch (err) {
            logger.error(`Failed to publish ${record.id}@${record.version}: ${err.message}`);
            const {owner, repo} = parseRepoUrl(record.repoUrl);
            uploadErrors.push({
                type: record.type,
                repo: `${owner}/${repo}`,
                version: record.version,
                error: err.message
            });
        }
    }

    // Apply recommended flags over every package, regardless of new versions, so a
    // recommendation toggle in registry.json propagates on the next sync.
    const recommendedResult = applyRecommendedFlags(currentPackages, recommendedAllowlist);
    currentPackages = recommendedResult.packagesJson;
    if (recommendedResult.changed) {
        logger.info('Recommended flags changed since last sync');
    }

    // Upload packages.json when versions were added or recommended flags changed.
    if (added.length > 0 || recommendedResult.changed) {
        logger.section('Uploading packages.json');
        const mergedPackages = mergePackagesSections(
            baseRemotePackages,
            currentPackages,
            ['devices', 'extensions']
        );
        await uploadJson(mergedPackages, 'packages.json');
        logger.success('packages.json updated');
    }

    // Upload translations to R2 and push to Transifex
    if (!skipTransifex && added.length > 0 && globalTranslations) {
        logger.section('Syncing Translations');

        await uploadTranslationsToR2(globalTranslations);
        await initTranslationsDir(GLOBAL_TRANSLATIONS_DIR, globalTranslations);

        logger.info('Pushing translations to Transifex...');
        const repoRoot = path.resolve(__dirname, '../..');
        const pushResult = await pushToTransifex(repoRoot);
        if (!pushResult.success) {
            throw new Error(`Failed to push translations to Transifex: ${pushResult.error}`);
        }
    }

    // Create issues for build and upload errors
    if (uploadErrors.length > 0) {
        const workflowRunUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ?
            `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` :
            null;
        await createErrorIssues(uploadErrors, workflowRunUrl);
    }

    // Generate and display report
    console.log(generateReport({
        added,
        skipped,
        errors: uploadErrors,
        repositoryStats,
        dryRun: false
    }));

    if (uploadErrors.length > 0) {
        logger.warn(`Sync completed with ${uploadErrors.length} error(s)`);
    }

    logger.success('Upload phase complete');
};

/**
 * Main sync function. Runs the build and upload phases in-process using a
 * temporary artifact directory. Intended for local/manual use; CI runs the two
 * phases as separate jobs via --phase.
 * @param {object} options - Sync options
 * @param {boolean} options.dryRun - Dry run mode (build only, no uploads)
 * @param {number} options.concurrency - Concurrency limit
 * @param {boolean} options.skipTransifex - Skip Transifex push
 * @param {boolean} options.rebuild - Re-process all versions from source
 */
export const sync = async (options = {}) => {
    logger.section('OpenBlock Registry Package Sync');

    try {
        const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), `${TEMP_DIR_PREFIX}artifact-`));
        try {
            await syncBuild(options, artifactDir);
            // Dry-run stops after the build phase (report already printed there).
            if (!options.dryRun) {
                await syncUpload(options, artifactDir);
            }
        } finally {
            await fs.rm(artifactDir, {recursive: true, force: true}).catch(() => {});
        }

        logger.success('Sync completed successfully!');

    } catch (err) {
        logger.error(`Sync failed: ${err.message}`);
        console.error(err.stack);
        process.exit(1);
    }
};

/**
 * Parse CLI arguments into sync options plus phase/artifact-directory selection.
 * @param {string[]} args - process.argv.slice(2)
 * @returns {object} Parsed options
 */
const parseArgs = (args) => {
    const options = {
        dryRun: args.includes('--dry-run'),
        skipTransifex: args.includes('--skip-transifex'),
        rebuild: args.includes('--rebuild'),
        concurrency: DEFAULT_CONCURRENCY,
        phase: null,
        artifactDir: null
    };

    const concurrencyArg = args.find(arg => arg.startsWith('--concurrency='));
    if (concurrencyArg) {
        options.concurrency = parseInt(concurrencyArg.split('=')[1], 10) || DEFAULT_CONCURRENCY;
    }

    const phaseArg = args.find(arg => arg.startsWith('--phase='));
    if (phaseArg) {
        options.phase = phaseArg.split('=')[1];
    }

    // --out (build phase) and --in (upload phase) both name the artifact directory.
    const dirArg = args.find(arg => arg.startsWith('--out=') || arg.startsWith('--in='));
    if (dirArg) {
        options.artifactDir = path.resolve(dirArg.split('=')[1]);
    }

    return options;
};

// CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const options = parseArgs(process.argv.slice(2));

    const run = async () => {
        if (options.phase === 'build') {
            if (!options.artifactDir) {
                throw new Error('--phase=build requires --out=<artifact dir>');
            }
            await syncBuild(options, options.artifactDir);
        } else if (options.phase === 'upload') {
            if (!options.artifactDir) {
                throw new Error('--phase=upload requires --in=<artifact dir>');
            }
            await syncUpload(options, options.artifactDir);
        } else {
            await sync(options);
        }
    };

    run().catch(err => {
        logger.error(err.message);
        console.error(err.stack);
        process.exit(1);
    });
}

export default {
    sync,
    syncBuild,
    syncUpload,
    runWithConcurrency,
    buildPackageEntry,
    buildRepository,
    generateReport,
    findCurrentEntry,
    applyApprovedDisplay,
    planReconciliation
};
