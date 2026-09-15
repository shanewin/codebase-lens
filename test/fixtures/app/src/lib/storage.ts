// A safe wrapper that shadows the global name, like cal.com's @calcom/lib/webstorage
export const localStorage = {
  getItem: (key: string): string | null => {
    try { return typeof window === 'undefined' ? null : window.localStorage.getItem(key) } catch { return null }
  },
}
