'use strict'

const api = require('../lib/api')
const files = require('../lib/files')
const path = require('path')

module.exports = async function sync({ silent } = {}) {
  const credentials = files.readEnv(process.cwd())
  if (!credentials) return  // Not a PM OS directory — silently exit

  const updates = await api.sync(credentials.apiKey, credentials.teamId)
  if (!updates) return  // API error — silently exit (don't block PM's session)

  let changeCount = 0

  for (const [filePath, content] of Object.entries(updates.contextFiles || {})) {
    const changed = files.writeIfChanged(path.join(process.cwd(), filePath), content)
    if (changed) changeCount++
  }

  for (const [slug, content] of Object.entries(updates.customSkills || {})) {
    const dest = path.join(process.cwd(), `.claude/skills/${slug}/SKILL.md`)
    const changed = files.writeIfChanged(dest, content)
    if (changed) changeCount++
  }

  for (const [filename, content] of Object.entries(updates.customAgents || {})) {
    const dest = path.join(process.cwd(), `.claude/agents/${filename}`)
    const changed = files.writeIfChanged(dest, content)
    if (changed) changeCount++
  }

  if (!silent && changeCount > 0) {
    process.stdout.write(`[mySecond] Synced ${changeCount} updated file(s).\n`)
  }
}
