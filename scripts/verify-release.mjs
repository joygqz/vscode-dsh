import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'))

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME
const expectedTag = `v${packageJson.version}`
const stableTagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

if (!tag) {
  console.error('Missing release tag. Pass it as an argument, for example: pnpm release:check v0.3.0')
  process.exit(1)
}

if (!stableTagPattern.test(tag)) {
  console.error(`Invalid release tag "${tag}". Expected a stable SemVer tag such as "${expectedTag}".`)
  process.exit(1)
}

if (tag !== expectedTag) {
  console.error(`Release tag "${tag}" does not match package.json version "${packageJson.version}".`)
  process.exit(1)
}

console.log(`Release tag ${tag} matches package.json.`)
