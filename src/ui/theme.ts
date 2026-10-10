export type Theme = 'system' | 'light' | 'dark';
const key = 'yumeewade.theme';
export function getTheme(): Theme {
  try {
    const value = localStorage.getItem(key);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch { return 'system'; }
}
export function setTheme(theme: Theme): void {
  try { localStorage.setItem(key, theme); } catch { /* A disabled store does not prevent applying the choice. */ }
  document.documentElement.dataset['theme'] = theme;
}
document.documentElement.dataset['theme'] = getTheme();

// Vite merges module entries and drops script blocking; the expectation link survives.
document.documentElement.id = 'theme-ready';