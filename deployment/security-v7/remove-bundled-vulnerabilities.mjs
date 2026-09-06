import { cp, readdir, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// meteor-node-stubs 1.2.29 embeds qs 6.15.2 inside its published tarball, so
// npm overrides cannot replace it. qs is also pinned as a direct application
// dependency; removing the embedded copy makes the stub resolve the reviewed
// top-level 6.16.0 implementation through normal Node resolution.
const floors = new Map([
  ['qs', '6.16.0'],
  ['tmp', '0.2.7'],
])

function compareVersions(left, right) {
  const a = left.split(/[.+-]/u).map((part) => Number.parseInt(part, 10) || 0)
  const b = right.split(/[.+-]/u).map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0)
  }
  return 0
}

async function removeKnownVulnerablePackages(root, replacementRoot) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory()) return
    const directory = resolve(root, entry.name)
    const metadata = await readFile(resolve(directory, 'package.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null)
    const floor = floors.get(metadata?.name)
    if (floor && compareVersions(metadata.version || '0', floor) < 0) {
      await rm(directory, { recursive: true, force: true })
      if (replacementRoot) {
        await cp(resolve(replacementRoot, metadata.name), directory, { recursive: true })
      }
      return
    }
    await removeKnownVulnerablePackages(directory, replacementRoot)
  }))
}

const scanRoot = process.argv[2]
  || new URL('../../node_modules/meteor-node-stubs/', import.meta.url).pathname
const replacementRoot = process.argv[3]

await removeKnownVulnerablePackages(scanRoot, replacementRoot)
