'use strict'

const api = require('../lib/api')
const files = require('../lib/files')
const plugin = require('../lib/plugin')
const identity = require('../lib/identity')
const path = require('path')
const os = require('os')
const fs = require('fs')

module.exports = async function join(token) {
  if (!token) {
    throw new Error('Usage: npx mysecond join [team-token]')
  }

  process.stdout.write('\n  Fetching team configuration...\n')
  const config = await api.join(token)
  // config = { teamSlug, teamId, apiKey, githubToken, contextFiles,
  //            customSkills, customAgents, customWorkflows, claudeMdOverride }

  const pmOsDir = path.join(os.homedir(), `${config.teamSlug}-pm-os`)

  if (fs.existsSync(pmOsDir)) {
    const forceFlag = process.argv.includes('--force')
    if (!forceFlag) {
      throw new Error(
        `A PM OS directory already exists at ${pmOsDir}.\nAdd --force to overwrite it: npx mysecond join ${token} --force`
      )
    }
  }

  process.stdout.write(`  Setting up your PM OS at ${pmOsDir}/\n`)
  files.createDirectoryStructure(pmOsDir)
  files.writeContextFiles(pmOsDir, config.contextFiles)
  files.writeCustomSkills(pmOsDir, config.customSkills)
  files.writeCustomAgents(pmOsDir, config.customAgents)
  files.writeCustomWorkflows(pmOsDir, config.customWorkflows)
  files.writeClaudeMd(pmOsDir, config.claudeMdOverride)

  process.stdout.write('  Installing mySecond plugin...\n')
  plugin.install('mysecond-ai/pm-os', config.githubToken)

  files.writeSettings(pmOsDir)
  files.writeEnv(pmOsDir, config.apiKey, config.teamId, config.githubToken)

  process.stdout.write('\n  One question before you start:\n\n')
  const { name, productArea } = await identity.prompt()
  identity.writeToMemory(name, productArea, config.teamSlug)

  process.stdout.write(`
  You're set up. Start your first session:

    cd ${pmOsDir}
    claude

`)
}
