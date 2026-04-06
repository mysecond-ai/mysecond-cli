'use strict'

const fs = require('fs')
const path = require('path')

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safePath(rootDir, filePath) {
  if (!filePath || filePath === '.') {
    throw new Error(`Invalid file path: ${filePath}`)
  }
  const root = path.resolve(rootDir)
  const resolved = path.resolve(rootDir, filePath)
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Path traversal blocked: ${filePath}`)
  }
  return resolved
}

function write(filePath, content) {
  mkdirp(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf8')
}

function writeIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8')
    if (existing === content) return false
  }
  write(filePath, content)
  return true
}

function createDirectoryStructure(rootDir) {
  const dirs = [
    'context',
    '.claude/skills',
    '.claude/agents',
    '.claude/workflows',
    'work/specs/outputs',
    'work/discovery/outputs',
    'work/strategy/outputs',
    'work/launches/outputs'
  ]
  for (const dir of dirs) {
    mkdirp(path.join(rootDir, dir))
  }
}

function writeContextFiles(rootDir, contextFiles) {
  for (const [filePath, content] of Object.entries(contextFiles || {})) {
    write(safePath(rootDir, filePath), content)
  }
}

function writeCustomSkills(rootDir, customSkills) {
  for (const [slug, content] of Object.entries(customSkills || {})) {
    write(path.join(rootDir, `.claude/skills/${slug}/SKILL.md`), content)
  }
}

function writeCustomAgents(rootDir, customAgents) {
  for (const [filename, content] of Object.entries(customAgents || {})) {
    write(path.join(rootDir, `.claude/agents/${filename}`), content)
  }
}

function writeCustomWorkflows(rootDir, customWorkflows) {
  for (const [slug, content] of Object.entries(customWorkflows || {})) {
    write(path.join(rootDir, `.claude/workflows/${slug}/workflow.md`), content)
  }
}

function writeClaudeMd(rootDir, overrideContent) {
  const base = `# PM Operating System — mySecond

Your PM OS is installed and ready. Stock skills are available via the mySecond plugin.
Run \`/mysecond:prd-generator\` to write a PRD, or describe what you need.

Context files are in \`context/\`. Keep them updated — skills read them automatically.

`
  const content = overrideContent
    ? `${base}\n## Team Instructions\n\n${overrideContent}\n`
    : base

  write(path.join(rootDir, 'CLAUDE.md'), content)
}

function writeSettings(rootDir) {
  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: 'npx @mysecond/cli sync --silent'
            }
          ]
        }
      ]
    }
  }
  write(path.join(rootDir, '.claude/settings.json'), JSON.stringify(settings, null, 2))
}

function writeEnv(rootDir, apiKey, teamId, githubToken) {
  const content = [
    `MYSECOND_API_KEY=${apiKey}`,
    `MYSECOND_TEAM_ID=${teamId}`,
    `GITHUB_TOKEN=${githubToken}`,
    ''
  ].join('\n')
  write(path.join(rootDir, '.env'), content)
}

function readEnv(dir) {
  const envPath = path.join(dir, '.env')
  if (!fs.existsSync(envPath)) return null

  const content = fs.readFileSync(envPath, 'utf8')
  const lines = content.split('\n').filter(l => l.includes('='))
  const env = {}
  for (const line of lines) {
    const [key, ...valueParts] = line.split('=')
    env[key.trim()] = valueParts.join('=').trim()
  }

  if (!env.MYSECOND_API_KEY || !env.MYSECOND_TEAM_ID) return null
  return { apiKey: env.MYSECOND_API_KEY, teamId: env.MYSECOND_TEAM_ID }
}

module.exports = {
  createDirectoryStructure,
  writeContextFiles,
  writeCustomSkills,
  writeCustomAgents,
  writeCustomWorkflows,
  writeClaudeMd,
  writeSettings,
  writeEnv,
  readEnv,
  writeIfChanged,
  write,
  safePath
}
