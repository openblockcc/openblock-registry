/**
 * Platform name mapping between Arduino and OpenBlock
 */

/**
 * Mapping from Arduino host names to OpenBlock host names
 */
export const ARDUINO_TO_OPENBLOCK = {
    'i686-mingw32': 'win32-ia32',
    'x86_64-mingw32': 'win32-x64',
    'i386-apple-darwin11': 'darwin-x64',
    'x86_64-apple-darwin': 'darwin-x64',
    'arm64-apple-darwin': 'darwin-arm64',
    'x86_64-pc-linux-gnu': 'linux-x64',
    'i686-pc-linux-gnu': 'linux-ia32',
    'aarch64-linux-gnu': 'linux-arm64',
    'arm-linux-gnueabihf': 'linux-arm'
};

/**
 * Mapping from OpenBlock host names to Arduino host names
 */
export const OPENBLOCK_TO_ARDUINO = Object.fromEntries(
    Object.entries(ARDUINO_TO_OPENBLOCK).map(([k, v]) => [v, k])
);

/**
 * All supported OpenBlock platforms
 */
export const OPENBLOCK_PLATFORMS = [
    'win32-ia32',
    'win32-x64',
    'darwin-x64',
    'darwin-arm64',
    'linux-x64',
    'linux-ia32',
    'linux-arm64',
    'linux-arm'
];

/**
 * GitHub runner to platforms mapping
 * Note: With direct download approach, any runner can build all platforms.
 * This mapping is kept for reference but is no longer a limitation.
 */
export const RUNNER_PLATFORMS = {
    // Any single runner can now build all platforms since we download resources directly
    'ubuntu-latest': [...OPENBLOCK_PLATFORMS],
    'windows-latest': [...OPENBLOCK_PLATFORMS],
    'macos-latest': [...OPENBLOCK_PLATFORMS]
};

/**
 * Arduino CLI download URLs by platform
 */
export const ARDUINO_CLI_URLS = {
    'win32-x64': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip',
    'win32-ia32': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_32bit.zip',
    'darwin-x64': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_macOS_64bit.tar.gz',
    'darwin-arm64': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_macOS_ARM64.tar.gz',
    'linux-x64': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_64bit.tar.gz',
    'linux-ia32': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_32bit.tar.gz',
    'linux-arm64': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_ARM64.tar.gz',
    'linux-arm': 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_ARMv7.tar.gz'
};

/**
 * Convert Arduino host name to OpenBlock host name
 * @param {string} arduinoHost - Arduino host name
 * @returns {string|null} OpenBlock host name or null if not found
 */
export const toOpenBlockPlatform = (arduinoHost) => {
    return ARDUINO_TO_OPENBLOCK[arduinoHost] ?? null;
};

/**
 * Convert OpenBlock host name to Arduino host name
 * @param {string} openblockHost - OpenBlock host name
 * @returns {string|null} Arduino host name or null if not found
 */
export const toArduinoPlatform = (openblockHost) => {
    return OPENBLOCK_TO_ARDUINO[openblockHost] ?? null;
};

/**
 * Get Arduino CLI download URL for a platform
 * @param {string} platform - OpenBlock platform name
 * @returns {string|null} Download URL or null if not found
 */
export const getArduinoCliUrl = (platform) => {
    return ARDUINO_CLI_URLS[platform] ?? null;
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
    ARDUINO_TO_OPENBLOCK,
    OPENBLOCK_TO_ARDUINO,
    OPENBLOCK_PLATFORMS,
    RUNNER_PLATFORMS,
    ARDUINO_CLI_URLS,
    toOpenBlockPlatform,
    toArduinoPlatform,
    getArduinoCliUrl,
    isPlatformSupported
};

