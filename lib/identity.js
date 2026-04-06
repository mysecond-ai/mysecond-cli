'use strict'

const readline = require('readline')
const fs = require('fs')
const path = require('path')
const os = require('os')

function prompt() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    rl.question('  What\'s your name? ', (name) => {
      rl.question('  What product area are you working on? ', (productArea) => {
        rl.close()
        resolve({ name: name.trim(), productArea: productArea.trim() })
      })
    })
  })
}

function writeToMemory(name, productArea, teamSlug) {
  const memoryPath = path.join(os.homedir(), '.claude', 'MEMORY.md')
  const companyName = teamSlug.replace(/-pm-os$/, '').replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())

  const block = `\n## mySecond Identity\n- Name: ${name}\n- Product area: ${productArea}\n- Company: ${companyName}\n- Team: ${teamSlug}\n`

  // Append to existing memory file, or create it
  if (fs.existsSync(memoryPath)) {
    const existing = fs.readFileSync(memoryPath, 'utf8')
    // Remove any previous mySecond Identity block before appending
    const cleaned = existing.replace(/\n## mySecond Identity[\s\S]*?(?=\n##|$)/g, '')
    fs.writeFileSync(memoryPath, cleaned + block, 'utf8')
  } else {
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true })
    fs.writeFileSync(memoryPath, `# Memory${block}`, 'utf8')
  }
}

module.exports = { prompt, writeToMemory }
