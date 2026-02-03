/**
 * Translation Generator Module
 * Parse and generate translations.js files
 */

/**
 * Parse translations.js file content
 * @param {string} content - File content
 * @returns {object} Parsed translation object
 */
export const parseTranslationsJs = function (content) {
    // ESM format: export default {...}
    const match = content.match(/export\s+default\s+(\{[\s\S]*\});?\s*$/);
    if (match) {
        // Replace single quotes with double quotes for JSON parsing
        const jsonStr = match[1].replace(/'/g, '"');
        return JSON.parse(jsonStr);
    }
    throw new Error('Failed to parse translations.js - unsupported format');
};

/**
 * Generate translations.js file content
 * @param {object} translations - Translation object
 * @returns {string} File content
 */
export const generateTranslationsJs = function (translations) {
    const header = `/* eslint-disable quote-props */
/* eslint-disable max-len */
/**
 * Translation file - automatically generated from Transifex.
 * Do NOT modify this file manually.
 * All translations are managed on Transifex platform.
 *
 * Structure:
 * - interface: translations for name/description (used by GUI formatMessage)
 * - extensions: translations for extension blocks (used by VM formatMessage)
 * - blocks: translations for Blockly blocks (used by Blockly.Msg)
 */
`;
    
    // Format with single quotes
    const formatted = JSON.stringify(translations, null, 4).replace(/"/g, "'");
    
    return `${header}
export default ${formatted};
`;
};

export default {
    parseTranslationsJs,
    generateTranslationsJs
};
