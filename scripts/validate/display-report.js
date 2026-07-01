/**
 * Authoritative display-channel report for PR validation (§5.5).
 *
 * The PR body is generated on the developer's machine and is therefore untrusted
 * (§5.1). This module is the trustworthy counterpart: for every plugin touched by
 * a PR it fetches the manifest and icons **at the exact git tag sync will
 * publish** (not the default branch — closing the audit/publish ref gap of
 * §5.1.3), renders what a user would actually see, and verifies that any
 * approved/{id}.json the PR commits matches that reality byte-for-byte.
 *
 * A maintainer reviews this report, never the PR body.
 */

import fs from 'fs/promises';
import path from 'path';
import {isValidSemver, compareSemver} from '../packages/calculate-diff.js';
import {extractDisplay, listIconFields, hashIconBytes, computeDisplayHash} from '../common/display-manifest.js';
import {readApprovedManifest} from '../common/approved-store.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

/**
 * Build request headers, attaching the token only for higher rate limits. The
 * report reads public data only, so the token is never required for correctness.
 * @param {object} [extra] - Extra headers
 * @returns {object} Headers
 */
const ghHeaders = (extra = {}) => {
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OpenBlock-Registry-Validator',
        ...extra
    };
    if (GITHUB_TOKEN) {
        headers.Authorization = `token ${GITHUB_TOKEN}`;
    }
    return headers;
};

/**
 * Parse a canonical GitHub repo URL.
 * @param {string} url - Repository URL
 * @returns {{owner: string, repo: string}|null} Parsed owner/repo or null
 */
const parseGitHubUrl = (url) => {
    const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return null;
    return {owner: match[1], repo: match[2]};
};

/**
 * Resolve the highest semver tag — the one sync will pick up (§5.5.2). Matches
 * sync's "newest tag wins" behaviour so the report pins the same ref.
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @returns {Promise<string|null>} Highest semver tag or null
 */
const resolveHighestTag = async (owner, repo) => {
    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/tags?per_page=100`, {
        headers: ghHeaders()
    });
    if (!response.ok) {
        return null;
    }
    const tags = await response.json();
    const semverTags = (Array.isArray(tags) ? tags : [])
        .map(t => t.name)
        .filter(isValidSemver)
        .sort((a, b) => -compareSemver(a, b));
    return semverTags[0] || null;
};

/**
 * Raw file URL on a specific ref.
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} ref - Git ref (tag)
 * @param {string} filePath - Repo-relative file path
 * @returns {string} raw.githubusercontent.com URL
 */
const rawUrl = (owner, repo, ref, filePath) =>
    `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.replace(/^\.\//, '')}`;

/**
 * Fetch and parse package.json at a ref.
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} ref - Git ref (tag)
 * @returns {Promise<object|null>} Parsed package.json or null
 */
const fetchPackageJsonAtRef = async (owner, repo, ref) => {
    const response = await fetch(rawUrl(owner, repo, ref, 'package.json'));
    if (!response.ok) return null;
    try {
        return JSON.parse(await response.text());
    } catch {
        return null;
    }
};

/**
 * Fetch and hash each icon's bytes at a ref.
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} ref - Git ref (tag)
 * @param {object} packageJson - Manifest at the ref
 * @returns {Promise<{icons: object, previews: Array}>} Icon hashes + render info
 */
const fetchIconHashesAtRef = async (owner, repo, ref, packageJson) => {
    const icons = {};
    const previews = [];
    for (const {field, value} of listIconFields(packageJson)) {
        // Only repo-relative icons can be fetched/hashed at a tag; absolute URLs
        // and data URIs are out of the developer repo's frozen tree.
        if (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:')) {
            previews.push({field, url: value, hashed: false});
            continue;
        }
        const url = rawUrl(owner, repo, ref, value);
        try {
            const response = await fetch(url);
            if (!response.ok) {
                previews.push({field, url, hashed: false});
                continue;
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            icons[field] = hashIconBytes(bytes);
            previews.push({field, url, hashed: true});
        } catch {
            previews.push({field, url, hashed: false});
        }
    }
    return {icons, previews};
};

/**
 * Render a frozen-message field (string or {id, default}) for the report table.
 * @param {*} value - Normalized display value
 * @returns {string} Markdown cell
 */
const renderMessage = (value) => {
    if (value === null || typeof value === 'undefined') return '—';
    if (typeof value === 'string') return value.replace(/\|/g, '\\|');
    if (typeof value === 'object' && 'default' in value) {
        const def = value.default || '';
        return `${def.replace(/\|/g, '\\|')} \`(${value.id})\``;
    }
    return JSON.stringify(value);
};

/**
 * Compute the authoritative display data for one plugin at its published tag.
 * @param {string} repoUrl - Repository URL
 * @returns {Promise<object>} Result with status, computed display, icons, hash
 */
const inspectPluginAtTag = async (repoUrl) => {
    const repoInfo = parseGitHubUrl(repoUrl);
    if (!repoInfo) {
        return {repoUrl, ok: false, error: 'Invalid GitHub URL'};
    }
    const {owner, repo} = repoInfo;

    const tag = await resolveHighestTag(owner, repo);
    if (!tag) {
        return {repoUrl, owner, repo, ok: false, error: 'No semver tag found'};
    }

    const packageJson = await fetchPackageJsonAtRef(owner, repo, tag);
    if (!packageJson) {
        return {repoUrl, owner, repo, tag, ok: false, error: `package.json unreadable at tag ${tag}`};
    }

    const openblock = packageJson.openblock || {};
    const id = openblock.deviceId || openblock.extensionId || null;
    const display = extractDisplay(packageJson);
    const {icons, previews} = await fetchIconHashesAtRef(owner, repo, tag, packageJson);
    const displayHash = computeDisplayHash(display, icons);

    return {repoUrl, owner, repo, tag, ok: true, id, display, icons, previews, displayHash};
};

/**
 * Render one plugin's authoritative report section, including the comparison
 * against the approved baseline committed in the PR (if any).
 * @param {object} info - Result of inspectPluginAtTag
 * @param {object|null} prApproved - approved/{id}.json from the PR (or null)
 * @returns {{markdown: string, error: boolean}} Section + whether it blocks merge
 */
const renderSection = (info, prApproved) => {
    const lines = [];
    let error = false;

    if (!info.ok) {
        lines.push(`#### ❌ ${info.repoUrl}`);
        lines.push('');
        lines.push(`Could not build an authoritative report: ${info.error}`);
        lines.push('');
        return {markdown: lines.join('\n'), error: true};
    }

    lines.push(`#### ${info.id || info.repoUrl} — \`${info.owner}/${info.repo}@${info.tag}\``);
    lines.push('');
    lines.push('| Field | Value at published tag (verified) |');
    lines.push('| ----- | --------------------------------- |');
    lines.push(`| ID | \`${info.id || '—'}\` |`);
    lines.push(`| Name | ${renderMessage(info.display.name)} |`);
    lines.push(`| Description | ${renderMessage(info.display.description)} |`);
    lines.push(`| Author | ${renderMessage(info.display.author)} |`);
    lines.push(`| manufactor | ${renderMessage(info.display.manufactor)} |`);
    lines.push(`| helpLink | ${renderMessage(info.display.helpLink)} |`);
    lines.push(`| learnMore | ${renderMessage(info.display.learnMore)} |`);
    lines.push(`| tags | ${Array.isArray(info.display.tags) ? info.display.tags.join(', ') : '—'} |`);
    lines.push(`| displayHash | \`${info.displayHash}\` |`);
    lines.push('');

    // Icons rendered straight from the tag so the reviewer sees the real bytes
    // (GitHub's camo proxy renders raw URLs in comments).
    for (const preview of info.previews) {
        if (preview.hashed) {
            lines.push(`Icon \`${preview.field}\` (from tag): <img src="${preview.url}" height="48" />`);
        } else {
            lines.push(`Icon \`${preview.field}\`: ${preview.url} (not hashable — external/data URI)`);
        }
    }
    lines.push('');

    // Baseline reconciliation: the committed approved/{id}.json must equal reality.
    if (prApproved) {
        if (prApproved.repository && prApproved.repository !== info.repoUrl) {
            lines.push(`> ❌ Approved baseline binds id \`${info.id}\` to \`${prApproved.repository}\`, but this PR registers \`${info.repoUrl}\`.`);
            error = true;
        }
        if (prApproved.displayHash === info.displayHash) {
            lines.push(`> ✅ Committed \`approved/${info.id}.json\` matches the tag (displayHash verified). Merging freezes this display.`);
        } else {
            lines.push(`> ❌ Committed \`approved/${info.id}.json\` displayHash \`${prApproved.displayHash}\` does **not** match the tag's \`${info.displayHash}\`. The baseline you are committing does not reflect the plugin at its published tag.`);
            error = true;
        }
    } else {
        lines.push(`> ⚠️ No \`approved/${info.id}.json\` in this PR. Code will sync, but the display channel stays unfrozen until a baseline is committed. To freeze, add the file with displayHash \`${info.displayHash}\`.`);
    }
    lines.push('');

    return {markdown: lines.join('\n'), error};
};

/**
 * Collect repo URLs that need an authoritative report: newly-registered repos
 * plus repos whose approved/{id}.json changed in this PR.
 * @param {object} prRegistry - PR registry.json
 * @param {object} baseRegistry - Base registry.json
 * @returns {string[]} Repo URLs to inspect
 */
const collectNewRepoUrls = (prRegistry, baseRegistry) => {
    const baseSet = new Set([...(baseRegistry?.devices || []), ...(baseRegistry?.extensions || [])]);
    const prUrls = [...(prRegistry?.devices || []), ...(prRegistry?.extensions || [])];
    return prUrls.filter(url => !baseSet.has(url));
};

/**
 * Read every approved/{id}.json in a directory into a map keyed by file name.
 * @param {string} dir - approved/ directory (may not exist)
 * @returns {Promise<Map<string, object>>} fileName → parsed record
 */
const readApprovedDir = async (dir) => {
    const map = new Map();
    if (!dir) return map;
    let entries;
    try {
        entries = await fs.readdir(dir);
    } catch {
        return map;
    }
    for (const name of entries) {
        if (!name.endsWith('.json')) continue;
        try {
            map.set(name, JSON.parse(await fs.readFile(path.join(dir, name), 'utf-8')));
        } catch {
            map.set(name, null);
        }
    }
    return map;
};

/**
 * Collect repository URLs whose approved/{id}.json was added or changed in the
 * PR (display-update PRs that don't touch registry.json still need a report).
 * @param {string} prApprovedDir - approved/ in the PR checkout
 * @param {string} baseApprovedDir - approved/ in the base checkout
 * @returns {Promise<string[]>} Repository URLs from changed baselines
 */
const collectChangedApprovedRepos = async (prApprovedDir, baseApprovedDir) => {
    const [prMap, baseMap] = await Promise.all([
        readApprovedDir(prApprovedDir),
        readApprovedDir(baseApprovedDir)
    ]);
    const urls = [];
    for (const [name, record] of prMap) {
        const base = baseMap.get(name);
        const changed = JSON.stringify(base) !== JSON.stringify(record);
        if (changed && record && record.repository) {
            urls.push(record.repository);
        }
    }
    return urls;
};

/**
 * Build the full authoritative display report for a PR.
 * @param {object} options - Inputs
 * @param {object} options.prRegistry - PR registry.json (may be null)
 * @param {object} options.baseRegistry - Base registry.json (may be null)
 * @param {string} options.prApprovedDir - Path to approved/ in the PR checkout
 * @param {string} [options.baseApprovedDir] - Path to approved/ in the base checkout
 * @returns {Promise<{markdown: string, hasError: boolean, sections: number}>} Report
 */
export const buildDisplayReport = async ({prRegistry, baseRegistry, prApprovedDir, baseApprovedDir}) => {
    const newRepos = collectNewRepoUrls(prRegistry, baseRegistry);
    const changedApprovedRepos = await collectChangedApprovedRepos(prApprovedDir, baseApprovedDir);
    const repoUrls = [...new Set([...newRepos, ...changedApprovedRepos])];

    if (repoUrls.length === 0) {
        return {markdown: '', hasError: false, sections: 0};
    }

    const lines = ['### 🤖 Authoritative Display Report', ''];
    lines.push('Rendered by the registry from each plugin **at its published git tag**. Review these values — not the PR description.');
    lines.push('');

    let hasError = false;
    let sections = 0;

    for (const repoUrl of repoUrls) {
        const info = await inspectPluginAtTag(repoUrl);
        // Read the baseline the PR itself commits (under the PR checkout's approved/).
        let prApproved = null;
        if (info.ok && info.id) {
            prApproved = await readApprovedManifest(info.id, prApprovedDir);
        }
        const {markdown, error} = renderSection(info, prApproved);
        lines.push(markdown);
        hasError = hasError || error;
        sections += 1;
    }

    return {markdown: lines.join('\n'), hasError, sections};
};

export default {
    buildDisplayReport
};
