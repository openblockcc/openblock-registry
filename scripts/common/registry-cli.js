/**
 * Trusted launcher for openblock-registry-cli.
 *
 * The CLI is run against untrusted plugin directories (build / i18n extract),
 * so it must never be resolved through `npx`, PATH, or the working directory's
 * node_modules/.bin — a malicious plugin can ship a dependency that drops a bin
 * named `openblock-registry-cli` into its own .bin, and npx would resolve that
 * first. Instead we pin to the copy installed in this scripts package and invoke
 * it as `node <absolute bin path>`: both the Node binary and the CLI script are
 * fixed, trusted absolute paths, so the plugin in `cwd` cannot hijack execution.
 */

import {createRequire} from 'module';
import {execFileSync} from 'child_process';
import path from 'path';

const require = createRequire(import.meta.url);

let cachedBinPath = null;

/**
 * Resolve the absolute path to the trusted openblock-registry-cli entry script.
 * Resolution is anchored on this module's location, so it can only find the copy
 * declared as a dependency of the scripts package — never a plugin-supplied bin.
 * @returns {string} Absolute path to the CLI entry script
 */
export const resolveCliBin = () => {
    if (cachedBinPath) {
        return cachedBinPath;
    }
    const pkgJsonPath = require.resolve('openblock-registry-cli/package.json');
    const pkg = require('openblock-registry-cli/package.json');
    const binField = pkg.bin;
    const binRel = typeof binField === 'string' ? binField : binField['openblock-registry-cli'];
    cachedBinPath = path.resolve(path.dirname(pkgJsonPath), binRel);
    return cachedBinPath;
};

/**
 * Run the trusted openblock-registry-cli with the current Node binary.
 * @param {string[]} args - CLI arguments (e.g. ['build'], ['i18n', 'extract'])
 * @param {object} [options] - Execution options
 * @param {string} [options.cwd] - Working directory (may be an untrusted plugin dir)
 * @param {string|Array} [options.stdio] - stdio configuration (default 'pipe')
 * @returns {string} Captured stdout (when stdio is 'pipe')
 */
export const runRegistryCli = (args, {cwd, stdio = 'pipe'} = {}) => {
    const bin = resolveCliBin();
    return execFileSync(process.execPath, [bin, ...args], {
        cwd,
        encoding: 'utf-8',
        stdio
    });
};

export default {
    resolveCliBin,
    runRegistryCli
};
