import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/** The anonymous free-lane credential: the literal upstream accepts. */
export const ANONYMOUS_KEY = 'public'

/** Where the resolved Zen key came from (logged; the key itself never is). */
export type ZenKeySource = 'config' | 'env' | 'cli-login' | 'anonymous'

/**
 * Resolve the bearer key for the Zen lane (synchronous: one small file read
 * at boot).
 *
 * Precedence: explicit config value > OPENCODE_ZEN_API_KEY env > the
 * `opencode` entry of the OpenCode CLI login
 * (`~/.local/share/opencode/auth.json`) > anonymous `public`.
 * Never throws and never exposes the key: an absent/unparseable login file
 * falls back to anonymous.
 */
export function resolveZenApiKey(options: {
  explicit?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  readAuthFile?: (path: string) => string
} = {}): { key: string; source: ZenKeySource } {
  const explicit = options.explicit?.trim()
  if (explicit) return { key: explicit, source: 'config' }
  const env = options.env ?? process.env
  const fromEnv = env.OPENCODE_ZEN_API_KEY?.trim()
  if (fromEnv) return { key: fromEnv, source: 'env' }
  const authPath = join(options.homeDir ?? homedir(), '.local', 'share', 'opencode', 'auth.json')
  try {
    const read = options.readAuthFile ?? ((p: string) => readFileSync(p, 'utf8'))
    const parsed = JSON.parse(read(authPath)) as { opencode?: { key?: unknown } }
    const key = typeof parsed.opencode?.key === 'string' ? parsed.opencode.key.trim() : ''
    if (key) return { key, source: 'cli-login' }
  } catch {
    // Absent/unparseable login file: stay anonymous.
  }
  return { key: ANONYMOUS_KEY, source: 'anonymous' }
}
