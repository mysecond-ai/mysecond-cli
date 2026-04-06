'use strict'

const COMPANION_URL = process.env.MYSECOND_COMPANION_URL || 'https://companion.mysecond.ai'

async function join(token) {
  const fetch = (await import('node-fetch')).default
  const res = await fetch(`${COMPANION_URL}/api/companion/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token })
  })

  if (res.status === 401) {
    throw new Error('This invite link is invalid or has expired. Ask your team admin for a new one.')
  }
  if (res.status === 403) {
    throw new Error('This invite link has already been used. Ask your team admin for a new link.')
  }
  if (!res.ok) {
    throw new Error(`Couldn't reach mySecond (${res.status}). Check your connection and try again.`)
  }

  return res.json()
}

async function sync(apiKey, teamId, since) {
  const fetch = (await import('node-fetch')).default
  const url = new URL(`${COMPANION_URL}/api/companion/cli-sync`)
  url.searchParams.set('team_id', teamId)
  if (since) url.searchParams.set('since', since)

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${apiKey}` }
  })

  if (!res.ok) return null
  return res.json()
}

module.exports = { join, sync }
