export const href = window.location.href
export function width() { return window.innerWidth }
export const isBrowser = typeof window !== 'undefined'
export const host = typeof window !== 'undefined' ? window.location.host : ''
// cal.com's isMac pattern: guarded by typeof window, references navigator
export const isMac = typeof window !== 'undefined' ? navigator.userAgent.includes('Mac') : false
// cal.com's embed-iframe pattern: guarded by a flag variable
if (isBrowser) {
  (window as unknown as { __app: number }).__app = 1
}
// A body that merely mentions typeof window must not count as a guard for an unguarded condition
if (href) {
  document.title = typeof window
}
export function check(opts: { window?: number }) { const { window = 1 } = opts; return window }
