/**
 * Translation Differ Module
 * Compare and merge translations
 */

/**
 * Compare translations to find differences
 * @param {object} current - Current translations
 * @param {object} incoming - Incoming translations from Transifex
 * @returns {object} Difference information
 */
export const compareTranslations = function (current, incoming) {
    const changes = {
        added: [],
        updated: [],
        total: 0
    };
    
    for (const resource of ['interface', 'extensions', 'blocks']) {
        const incomingResource = incoming[resource] || {};
        const currentResource = current[resource] || {};
        
        for (const [locale, translations] of Object.entries(incomingResource)) {
            const currentLocale = currentResource[locale] || {};
            
            for (const [key, value] of Object.entries(translations)) {
                // Skip empty values
                if (!value || value.trim() === '') continue;

                const currentValue = currentLocale[key];

                if (typeof currentValue === 'undefined') {
                    changes.added.push({resource, locale, key, value});
                    changes.total++;
                } else if (currentValue !== value) {
                    changes.updated.push({
                        resource,
locale,
key,
                        oldValue: currentValue,
                        newValue: value
                    });
                    changes.total++;
                }
            }
        }
    }
    
    return {
        hasChanges: changes.total > 0,
        changes
    };
};

/**
 * Merge translations (Transifex takes priority)
 * @param {object} current - Current translations
 * @param {object} incoming - Incoming translations from Transifex
 * @returns {object} Merged translations
 */
export const mergeTranslations = function (current, incoming) {
    const merged = JSON.parse(JSON.stringify(current));
    
    for (const resource of ['interface', 'extensions', 'blocks']) {
        if (!merged[resource]) merged[resource] = {};
        const incomingResource = incoming[resource] || {};
        
        for (const [locale, translations] of Object.entries(incomingResource)) {
            if (!merged[resource][locale]) merged[resource][locale] = {};
            
            for (const [key, value] of Object.entries(translations)) {
                if (value && value.trim() !== '') {
                    merged[resource][locale][key] = value;
                }
            }
        }
    }

    return merged;
};

export default {
    compareTranslations,
    mergeTranslations
};
