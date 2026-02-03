/**
 * GitHub PR Module (Fork Mode)
 * Create Pull Requests via forking
 */

import logger from '../common/logger.js';

const GITHUB_API = 'https://api.github.com';
const BOT_TOKEN = process.env.PLUGIN_GITHUB_TOKEN;

/**
 * Make a GitHub API request
 * @param {string} url - API URL
 * @param {object} options - Fetch options
 * @returns {Promise<object>} Response data
 */
const githubRequest = async function (url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `token ${BOT_TOKEN}`,
            'User-Agent': 'OpenBlock-Registry-Bot',
            ...options.headers
        }
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${error}`);
    }

    return response.json();
};

/**
 * Get authenticated user info
 * @returns {Promise<object>} User info
 */
const getAuthenticatedUser = async function () {
    return githubRequest(`${GITHUB_API}/user`);
};

/**
 * Ensure fork exists (create if not exists)
 * @param {string} owner - Original repo owner
 * @param {string} repo - Repo name
 * @returns {Promise<object>} Fork info
 */
const ensureFork = async function (owner, repo) {
    const user = await getAuthenticatedUser();
    const botUsername = user.login;
    
    // Check if fork already exists
    try {
        const fork = await githubRequest(`${GITHUB_API}/repos/${botUsername}/${repo}`);
        if (fork.fork && fork.parent?.full_name === `${owner}/${repo}`) {
            logger.debug(`  Fork already exists: ${botUsername}/${repo}`);
            return {owner: botUsername, repo, existed: true};
        }
    } catch (err) {
        // Fork doesn't exist, continue to create
    }
    
    // Create fork
    logger.debug(`  Creating fork of ${owner}/${repo}...`);
    await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/forks`, {
        method: 'POST'
    });
    
    // Wait for fork creation
    await new Promise(resolve => setTimeout(resolve, 3000));

    return {owner: botUsername, repo, existed: false};
};

/**
 * Sync fork to upstream latest
 * @param {string} forkOwner - Fork owner
 * @param {string} repo - Repo name
 * @param {string} upstreamOwner - Upstream owner
 * @returns {Promise<string>} Default branch name
 */
const syncFork = async function (forkOwner, repo, upstreamOwner) {
    const upstream = await githubRequest(`${GITHUB_API}/repos/${upstreamOwner}/${repo}`);
    const defaultBranch = upstream.default_branch;
    
    try {
        await githubRequest(`${GITHUB_API}/repos/${forkOwner}/${repo}/merge-upstream`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({branch: defaultBranch})
        });
        logger.debug(`  Synced fork to upstream`);
    } catch (err) {
        logger.warn(`  Failed to sync fork: ${err.message}`);
    }

    return defaultBranch;
};

/**
 * Get branch SHA
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} branch - Branch name
 * @returns {Promise<string>} SHA
 */
const getBranchSha = async function (owner, repo, branch) {
    const ref = await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    return ref.object.sha;
};

/**
 * Create branch
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} branchName - New branch name
 * @param {string} sha - Base SHA
 */
const createBranch = async function (owner, repo, branchName, sha) {
    await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            ref: `refs/heads/${branchName}`,
            sha
        })
    });
};

/**
 * Get file info
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} path - File path
 * @param {string} ref - Git ref
 * @returns {Promise<object>} File info
 */
const getFileInfo = async function (owner, repo, path, ref) {
    return githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${ref}`);
};

/**
 * Update file
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} path - File path
 * @param {string} content - File content
 * @param {string} message - Commit message
 * @param {string} branch - Branch name
 * @param {string} sha - Current file SHA
 */
const updateFile = async function (owner, repo, path, content, message, branch, sha) {
    await githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            message,
            content: Buffer.from(content).toString('base64'),
            branch,
            sha
        })
    });
};

/**
 * Create Pull Request
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} title - PR title
 * @param {string} body - PR body
 * @param {string} head - Head branch (fork:branch)
 * @param {string} base - Base branch
 * @returns {Promise<object>} PR info
 */
const createPR = async function (owner, repo, title, body, head, base) {
    return githubRequest(`${GITHUB_API}/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title, body, head, base})
    });
};

/**
 * Generate PR body
 * @param {object} changes - Changes object
 * @returns {string} PR body markdown
 */
const generatePRBody = function (changes) {
    const addedSummary = changes.added.slice(0, 5)
        .map(c => `- \`${c.key}\` (${c.locale})`)
        .join('\n');

    const updatedSummary = changes.updated.slice(0, 5)
        .map(c => `- \`${c.key}\` (${c.locale})`)
        .join('\n');

    const moreCount = changes.total - Math.min(changes.added.length, 5) - Math.min(changes.updated.length, 5);

    return `## Translation Update

This PR was automatically generated by OpenBlock Registry Bot.

### Summary
| Type | Count |
|------|-------|
| Added | ${changes.added.length} |
| Updated | ${changes.updated.length} |
| **Total** | **${changes.total}** |

### Changes
${addedSummary}
${updatedSummary}
${moreCount > 0 ? `\n... and ${moreCount} more changes` : ''}

---
*Translations synced from [Transifex](https://www.transifex.com/openblockcc/openblock-resources/)*
`;
};

/**
 * Create translation update PR (Fork mode)
 * @param {object} options - Options
 * @param {string} options.owner - Original repo owner
 * @param {string} options.repo - Repo name
 * @param {string} options.translationsPath - Path to translations file
 * @param {string} options.newContent - New file content
 * @param {object} options.changes - Changes object
 * @returns {Promise<object>} PR info
 */
export const createTranslationPR = async function (options) {
    const {owner, repo, translationsPath, newContent, changes} = options;

    // 1. Ensure fork exists
    logger.info(`  Forking ${owner}/${repo}...`);
    const fork = await ensureFork(owner, repo);

    // 2. Sync fork to upstream latest
    const defaultBranch = await syncFork(fork.owner, repo, owner);

    // 3. Create new branch
    const branchName = `translations-${Date.now()}`;
    const baseSha = await getBranchSha(fork.owner, repo, defaultBranch);
    await createBranch(fork.owner, repo, branchName, baseSha);
    logger.debug(`  Created branch: ${branchName}`);

    // 4. Get current file SHA
    const fileInfo = await getFileInfo(fork.owner, repo, translationsPath, defaultBranch);

    // 5. Update file
    await updateFile(
        fork.owner, repo, translationsPath, newContent,
        'Update translations from Transifex',
        branchName, fileInfo.sha
    );
    logger.debug(`  Updated ${translationsPath}`);

    // 6. Create PR (from fork to original repo)
    const pr = await createPR(
        owner, repo,
        'Update translations from Transifex',
        generatePRBody(changes),
        `${fork.owner}:${branchName}`,
        defaultBranch
    );

    return {
        number: pr.number,
        url: pr.html_url
    };
};

export default {
    createTranslationPR
};
