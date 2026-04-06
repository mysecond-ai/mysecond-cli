'use strict'

const { execSync } = require('child_process')

function install(pluginRef, githubToken) {
  // Verify claude is installed
  try {
    execSync('claude --version', { stdio: 'pipe' })
  } catch {
    throw new Error("Claude Code isn't installed. Install it at claude.ai/code, then run this command again.")
  }

  // Run plugin install with GITHUB_TOKEN in environment
  try {
    execSync(`claude plugin install ${pluginRef}`, {
      stdio: 'inherit',
      env: { ...process.env, GITHUB_TOKEN: githubToken }
    })
  } catch (err) {
    throw new Error(`Plugin installation failed. Run 'claude plugin install ${pluginRef}' manually after setup.`)
  }
}

module.exports = { install }
