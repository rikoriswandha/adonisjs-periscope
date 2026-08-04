export type ThemePreference = 'light' | 'dark' | 'system'
export type Density = 'compact' | 'comfortable'

const THEME_STORAGE_KEY = 'periscope-theme'
const DENSITY_STORAGE_KEY = 'periscope-density'

/**
 * Dark is the product default: this dashboard is read beside a dark editor
 * during a debugging session, not browsed in daylight.
 */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // Private-mode storage failures fall through to the default.
  }
  return 'dark'
}

export function readDensity(): Density {
  try {
    const stored = localStorage.getItem(DENSITY_STORAGE_KEY)
    if (stored === 'compact' || stored === 'comfortable') return stored
  } catch {
    // Private-mode storage failures fall through to the default.
  }
  return 'compact'
}

/**
 * The document always carries exactly one of `dark` / `light`. Tailwind's
 * `dark:` variant keys off the class, so leaving the element unclassed would
 * silently disable every dark-variant rule in `components/ui`.
 */
export function applyThemePreference(theme: ThemePreference): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme

  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.classList.toggle('light', resolved === 'light')

  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The in-memory preference still works when persistence is unavailable.
  }
}

export function applyDensity(density: Density): void {
  document.documentElement.dataset.density = density

  try {
    localStorage.setItem(DENSITY_STORAGE_KEY, density)
  } catch {
    // The in-memory preference still works when persistence is unavailable.
  }
}
