export function detectLanguage(value) {
  return /^en(?:-|$)/i.test(value || '') ? 'en' : 'id';
}
export function translator(language, dictionaries) {
  return (key, vars = {}) => String(dictionaries[language]?.[key] ?? dictionaries.en?.[key] ?? key)
    .replace(/\{([a-zA-Z]+)\}/g, (match, name) => Object.hasOwn(vars, name) ? String(vars[name]) : match);
}
