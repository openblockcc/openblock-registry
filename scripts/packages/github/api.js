/**
 * GitHub API wrapper for OpenBlock Registry
 * Handles fetching tags, package.json, and creating issues
 */

import logger from '../../common/logger.js';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

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

    if (GITHUB_TOKEN) {
        headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }

    const response = await fetch(url, {
        ...options,
        headers
    });

    // Handle rate limiting
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        const resetTime = parseInt(response.headers.get('x-ratelimit-reset')) * 1000;
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
 * Fetch all tags from a GitHub repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<Array<{name: string, commit: {sha: string}}>>} Array of tags
 */
export const fetchTags = async (owner, repo) => {
    const tags = [];
    let page = 1;
    const perPage = 100;

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
 * Create an issue in a GitHub repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} title - Issue title
 * @param {string} body - Issue body (markdown)
 * @param {Array<string>} labels - Issue labels
 * @returns {Promise<{number: number, url: string}>} Created issue info
 */
export const createIssue = async (owner, repo, title, body, labels = []) => {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues`;
    
    try {
        const data = await githubRequest(url, {
            method: 'POST',
            body: JSON.stringify({
                title,
                body,
                labels
            })
        });

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
    createIssue
};

