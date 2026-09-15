import { Header } from '@/components/Header'
import { ServerWithHook } from '@/components/ServerWithHook'
import { href, width, isBrowser, host, check } from '@/lib/browser'
import { savedTheme } from '@/lib/prefs'

export const metadata = { title: 'Fixture' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body><Header /><ServerWithHook />{String([href, width, isBrowser, host, check, savedTheme])}{children}</body></html>
}
