'use strict'

const api = require('../lib/api')
const files = require('../lib/files')

let cachedCredentials = null
let lastSyncTime = 0
const SYNC_INTERVAL_MS = 5000

module.exports = async function sync({ silent } = {}) {
  if (!cachedCredentials) {
    cachedCredentials = files.readEnv(process.cwd())
  }
  if (!cachedCredentials) return

  const now = Date.now()
  if (now - lastSyncTime < SYNC_INTERVAL_MS) return
  lastSyncTime = now

  const updates = await api.sync(cachedCredentials.apiKey, cachedCredentials.teamId)
  if (!updates) return

  let changeCount = 0
  const cwd = process.cwd()

  for (const [filePath, content] of Object.entries(updates.contextFiles || {})) {
    const changed = files.writeIfChanged(files.safePath(cwd, filePath), content)
    if (changed) changeCount++
  }

  for (const [slug, content] of Object.entries(updates.customSkills || {})) {
    const dest = files.safePath(cwd, `.claude/skills/${slug}/SKILL.md`)
    const changed = files.writeIfChanged(dest, content)
    if (changed) changeCount++
  }

  for (const [filename, content] of Object.entries(updates.customAgents || {})) {
    const dest = files.safePath(cwd, `.claude/agents/${filename}`)
    const changed = files.writeIfChanged(dest, content)
    if (changed) changeCount++
  }

  if (!silent && changeCount > 0) {
    process.stdout.write(`[mySecond] Synced ${changeCount} updated file(s).\n`)
  }
}
