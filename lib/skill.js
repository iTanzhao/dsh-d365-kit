/**
 * Ships the troubleshooting skill with the plugin.
 *
 * The Markdown under `skills/` is the only copy: it is versioned with the code,
 * reviewed like the code, and registered into the Host `skills` registry on
 * apply. That means installing the bundle makes the skill available to every
 * session — nobody has to copy a file into `~/.dsh/skills` by hand.
 *
 * The registry call is optional: a profile without the `skills` service (or an
 * older Host) simply gets the tools and no skill.
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_FILE = fileURLToPath(new URL('../skills/d365-troubleshooting/SKILL.md', import.meta.url))

/**
 * Split a SKILL.md into its front matter and body. Only the two fields the
 * registry cares about are read; anything else in the block is left alone.
 * @param text - the raw file.
 */
function parseSkillFile(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { name: undefined, description: undefined, body: text.trim() }
  const front = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) front[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { name: front.name, description: front.description, body: text.slice(match[0].length).trim() }
}

/**
 * Build the registration object, or `undefined` when the file is missing.
 * `resourceBase` points at the skill directory so relative references in the
 * body (if it ever grows any) resolve next to the file.
 */
export function troubleshootingSkill() {
  let text
  try {
    text = readFileSync(SKILL_FILE, 'utf8')
  } catch {
    return undefined
  }
  const { name, description, body } = parseSkillFile(text)
  if (!name || !description || !body) return undefined
  return {
    name,
    description,
    content: body,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: dirname(SKILL_FILE) },
    // Model-invocable: it shows up in the catalog and the agent picks it up by
    // description match. User-invocable too, so it can be called by name.
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/**
 * Register the skill into the calling context's layer, following the service
 * when it appears later (a plugin that applies before the registry would
 * otherwise miss it and never retry).
 * @param ctx - host context.
 * @returns a disposer, or a no-op when the registry is unavailable.
 */
export function registerSkills(ctx) {
  const attach = (host) => {
    const skill = troubleshootingSkill()
    if (!skill) return
    host.effect(() => host.skills.register(skill))
  }
  if (typeof ctx.inject === 'function') return ctx.inject(['skills'], attach)
  if (typeof ctx.get === 'function' && ctx.get('skills')) attach(ctx)
  return () => {}
}
