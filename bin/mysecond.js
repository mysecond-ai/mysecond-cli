#!/usr/bin/env node
'use strict'

const args = process.argv.slice(2)
const [command, ...rest] = args

if (command === 'join') {
  const token = rest[0]
  require('../commands/join')(token).catch(err => {
    console.error('\n  Error:', err.message)
    process.exit(1)
  })
} else if (command === 'sync') {
  const silent = rest.includes('--silent')
  require('../commands/sync')({ silent }).catch(err => {
    if (!silent) console.error('[mySecond sync error]', err.message)
    // Never fail loudly from a hook — PM shouldn't see sync errors
  })
} else {
  console.error(`Unknown command: ${command || '(none)'}`)
  console.error('Usage: npx mysecond join [team-token]')
  process.exit(1)
}
