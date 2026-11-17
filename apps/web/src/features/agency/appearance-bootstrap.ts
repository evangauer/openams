import {
  AGENCY_SCHEMES,
  DEFAULT_THEME,
  SCHEME_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./appearance-options";

// React serializes this as an HTML attribute. Configuration is data, never JavaScript.
export const themeBootData = JSON.stringify({
  theme: { key: THEME_STORAGE_KEY, values: [DEFAULT_THEME], fallback: DEFAULT_THEME },
  scheme: { key: SCHEME_STORAGE_KEY, values: AGENCY_SCHEMES.map(({ id }) => id), fallback: "saffron" },
});

/** Fixed code runs before paint; query/storage values only select allowlisted options. */
export const themeBootScript = `try {
  var appearance = JSON.parse(document.currentScript.dataset.appearance);
  var query = new URLSearchParams(location.search);
  ["theme", "scheme"].forEach(function (attribute) {
    var setting = appearance[attribute];
    var requested = query.get(attribute);
    var saved = localStorage.getItem(setting.key);
    var value = setting.values.indexOf(requested) >= 0 ? requested
      : setting.values.indexOf(saved) >= 0 ? saved : setting.fallback;
    document.documentElement.dataset[attribute] = value;
    if (requested === value) localStorage.setItem(setting.key, value);
  });
} catch (error) {}`;
