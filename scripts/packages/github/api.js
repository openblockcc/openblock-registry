/**
 * GitHub API wrapper for OpenBlock Registry
 * Handles fetching tags, package.json, and creating issues
 */

import logger from '../../common/logger.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
// Use PLUGIN_GITHUB_TOKEN for third-party repo operations (creating issues in plugin repos)
// Falls back to GITHUB_TOKEN if not available
const PLUGIN_GITHUB_TOKEN = process.env.PLUGIN_GITHUB_TOKEN || GITHUB_TOKEN;

/**
 * Make a GitHub API request with rate limit handling
 * @param {string} url - API URL
 * @param {object} options - Fetch options
 * @returns {Promise<object>} Response data
 */
const githubRequest = async (url, options = {}) => {
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OpenBlock-Registry',
        ...options.headers
    };

    // Default to the read-only GITHUB_TOKEN; callers touching third-party repos
    // can pass their own token (e.g. PLUGIN_GITHUB_TOKEN) via options.token.
    const token = options.token || GITHUB_TOKEN;
    if (token) {
        headers.Authorization = `token ${token}`;
    }

    const response = await fetch(url, {
        ...options,
        headers
    });

    // Handle rate limiting
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        const resetTime = parseInt(response.headers.get('x-ratelimit-reset'), 10) * 1000;
        const waitTime = resetTime - Date.now();
        
        if (waitTime > 0) {
            logger.warn(`Rate limit exceeded. Waiting ${Math.ceil(waitTime / 1000)}s...`);
            await new Promise(resolve => setTimeout(resolve, waitTime + 1000));
            // Retry the request
            return githubRequest(url, options);
        }
    }

    if (!response.ok) {
        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
};

/**
 * Parse GitHub repository URL
 * @param {string} url - GitHub repository URL
 * @returns {{owner: string, repo: string}} Owner and repo name
 */
export const parseRepoUrl = (url) => {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
    if (!match) {
        throw new Error(`Invalid GitHub URL: ${url}`);
    }
    return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, '')
    };
};

/**
 * Fetch all tags from a GitHub repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<Array<{name: string, commit: {sha: string}}>>} Array of tags
 */
export const fetchTags = async (owner, repo) => {
    const tags = [];
    let page = 1;
    const perPage = 100;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/tags?per_page=${perPage}&page=${page}`;
        const data = await githubRequest(url);

        if (data.length === 0) {
            break;
        }

        tags.push(...data);
        
        if (data.length < perPage) {
            break;
        }

        page++;
    }

    logger.debug(`Fetched ${tags.length} tags from ${owner}/${repo}`);
    return tags;
};

/**
 * Fetch package.json content from a specific tag
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} tag - Tag name
 * @returns {Promise<object>} package.json content
 */
export const fetchPackageJson = async (owner, repo, tag) => {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/package.json?ref=${tag}`;
    
    try {
        const data = await githubRequest(url);
        
        if (data.encoding === 'base64') {
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            return JSON.parse(content);
        }
        
        throw new Error('Unexpected encoding for package.json');
    } catch (err) {
        logger.warn(`Failed to fetch package.json for ${owner}/${repo}@${tag}: ${err.message}`);
        throw err;
    }
};

/**
 * Find an open issue in a repository whose body contains a given marker string.
 * Used to deduplicate auto-filed sync-error issues: the marker encodes a stable
 * key (repo@version) so a still-unfixed failure maps to a single open issue
 * instead of a fresh duplicate every sync run.
 *
 * Scans open issues (skipping pull requests) rather than filtering by label,
 * because the bot lacks triage permission on third-party repos and cannot rely
 * on labels being applied there. Authenticates with PLUGIN_GITHUB_TOKEN, the same
 * token used to create the issues.
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} marker - Marker substring to look for in issue bodies
 * @returns {Promise<{number: number, url: string}|null>} Matching issue, or null
 */
export const findOpenIssueByMarker = async (owner, repo, marker) => {
    let page = 1;
    const perPage = 100;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues` +
            `?state=open&per_page=${perPage}&page=${page}`;
        const data = await githubRequest(url, {token: PLUGIN_GITHUB_TOKEN});

        for (const item of data) {
            // The issues endpoint also returns pull requests; skip those.
            if (item.pull_request) {
                continue;
            }
            if (item.body && item.body.includes(marker)) {
                return {number: item.number, url: item.html_url};
            }
        }

        if (data.length < perPage) {
            return null;
        }
        page++;
    }
};

/**
 * Create an issue in a GitHub repository
 * Uses PLUGIN_GITHUB_TOKEN for authentication to third-party repos
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} title - Issue title
 * @param {string} body - Issue body (markdown)
 * @param {Array<string>} labels - Issue labels
 * @returns {Promise<{number: number, url: string}>} Created issue info
 */
export const createIssue = async (owner, repo, title, body, labels = []) => {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`;

    // Use PLUGIN_GITHUB_TOKEN for creating issues in third-party repos
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OpenBlock-Registry',
        'Content-Type': 'application/json'
    };

    if (PLUGIN_GITHUB_TOKEN) {
        headers.Authorization = `token ${PLUGIN_GITHUB_TOKEN}`;
    } else {
        logger.warn('PLUGIN_GITHUB_TOKEN not set, issue creation may fail for third-party repos');
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                title,
                body,
                labels
            })
        });

        if (!response.ok) {
            throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        logger.success(`Created issue #${data.number} in ${owner}/${repo}`);
        return {
            number: data.number,
            url: data.html_url
        };
    } catch (err) {
        logger.error(`Failed to create issue in ${owner}/${repo}: ${err.message}`);
        throw err;
    }
};

export default {
    parseRepoUrl,
    fetchTags,
    fetchPackageJson,
    findOpenIssueByMarker,
    createIssue
};
