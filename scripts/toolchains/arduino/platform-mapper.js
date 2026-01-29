/**
 * Platform name mapping between Arduino and OpenBlock
 * Uses fuzzy matching based on arch and OS keywords
 */

/**
 * Platform definitions with arch keywords, exclude keywords, and OS keywords
 * A host string matches if it contains BOTH an arch keyword AND an OS keyword
 * and does NOT contain any exclude keyword
 */
export const PLATFORM_MATCHERS = [
    // Windows
    {
        platform: 'win32-x64',
        archKeywords: ['x86_64', 'x64', 'amd64'],
        osKeywords: ['mingw', 'windows', 'win32', 'win64']
    },
    {
        platform: 'win32-ia32',
        archKeywords: ['i686', 'i386', 'x86', 'ia32'],
        excludeKeywords: ['x86_64'],
        osKeywords: ['mingw', 'windows', 'win32']
    },
    // macOS
    {
        platform: 'darwin-arm64',
        archKeywords: ['arm64', 'aarch64'],
        osKeywords: ['darwin', 'apple', 'macos', 'osx']
    },
    {
        platform: 'darwin-x64',
        archKeywords: ['x86_64', 'x64', 'amd64', 'i386'],
        osKeywords: ['darwin', 'apple', 'macos', 'osx']
    },
    // Linux
    {
        platform: 'linux-arm64',
        archKeywords: ['arm64', 'aarch64'],
        osKeywords: ['linux']
    },
    {
        platform: 'linux-arm',
        archKeywords: ['arm', 'armv6', 'armv7', 'armhf', 'gnueabihf'],
        excludeKeywords: ['arm64', 'aarch64'],
        osKeywords: ['linux']
    },
    {
        platform: 'linux-x64',
        archKeywords: ['x86_64', 'x64', 'amd64'],
        osKeywords: ['linux']
    }
];

/**
 * All supported OpenBlock platforms (primary targets)
 */
export const OPENBLOCK_PLATFORMS = [
    'win32-x64',
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-arm64',
    'linux-arm'
];

/**
 * Platform fallback mapping
 * When a platform doesn't have native binaries, try the fallback platform
 * - darwin-arm64 can run x64 binaries via Rosetta 2
 * - win32-x64 can run ia32 binaries via WoW64
 */
export const PLATFORM_FALLBACKS = {
    'darwin-arm64': 'darwin-x64',
    'win32-x64': 'win32-ia32'
};

/**
 * Convert Arduino host name to OpenBlock host name using fuzzy matching
 * Matches if the host string contains BOTH an arch keyword AND an OS keyword,
 * and does NOT contain any exclude keyword
 * @param {string} arduinoHost - Arduino host name (e.g., 'x86_64-apple-darwin14')
 * @returns {string|null} OpenBlock host name or null if not found
 */
export const toOpenBlockPlatform = (arduinoHost) => {
    if (!arduinoHost) return null;

    const hostLower = arduinoHost.toLowerCase();

    for (const matcher of PLATFORM_MATCHERS) {
        const hasArch = matcher.archKeywords.some(kw => hostLower.includes(kw.toLowerCase()));
        const hasOs = matcher.osKeywords.some(kw => hostLower.includes(kw.toLowerCase()));
        const hasExclude = matcher.excludeKeywords?.some(kw => hostLower.includes(kw.toLowerCase()));

        if (hasArch && hasOs && !hasExclude) {
            return matcher.platform;
        }
    }

    return null;
};

/**
 * Get fallback platform for a given platform
 * @param {string} platform - OpenBlock platform name
 * @returns {string|null} Fallback platform or null if no fallback
 */
export const getFallbackPlatform = (platform) => {
    return PLATFORM_FALLBACKS[platform] ?? null;
};

/**
 * Check if a platform is supported
 * @param {string} platform - OpenBlock platform name
 * @returns {boolean} True if platform is supported
 */
export const isPlatformSupported = (platform) => {
    return OPENBLOCK_PLATFORMS.includes(platform);
};

export default {
    PLATFORM_MATCHERS,
    OPENBLOCK_PLATFORMS,
    PLATFORM_FALLBACKS,
    toOpenBlockPlatform,
    getFallbackPlatform,
    isPlatformSupported
};
