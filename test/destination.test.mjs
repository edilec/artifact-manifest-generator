import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { sameFileReason } from '../src/destination.mjs'

/**
 * Where the manifest is allowed to land.
 *
 * This tool destroyed two files it was never asked to touch, and exited 0 both
 * times printing "Wrote 1 artifact(s)": a file outside the working directory
 * reached through a symbolic link at the destination, and a file it had just
 * hashed. Every row below is one of the three independent holes, and none of
 * them catches the others:
 *
 *   symlink at the destination   `realpath` RESOLVES it, and resolving is the
 *                                dangerous act, so it is refused by `lstat`
 *                                before anything is opened
 *   symlinked parent directory   a lexical prefix check passes for
 *                                `root/link/out` where `link` leaves the root
 *   hard link to an input        no target to resolve, no shared path; only
 *                                device plus inode sees that it is one file
 *
 * The four allowed rows at the end are not decoration. A guard that refuses
 * everything passes every data-loss test above while making the tool useless,
 * so the destinations that must still work are pinned with the same weight.
 */

const execFileAsync = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectDirectory, 'bin/artifact-manifest-generator.mjs')

async function workspace() {
  const base = await mkdtemp(join(tmpdir(), 'amg-destination-'))
  const root = join(base, 'root')
  await mkdir(join(root, 'dist'), { recursive: true })
  await mkdir(join(base, 'outside'), { recursive: true })
  await writeFile(join(root, 'dist', 'a.txt'), 'artifact bytes\n')
  return { base, root, outside: join(base, 'outside') }
}

async function generate(root, args) {
  return execFileAsync(process.execPath, [cli, 'generate', 'dist', ...args], { cwd: root, encoding: 'utf8' })
    .then((result) => ({ code: 0, ...result }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }))
}

async function withWorkspace(body) {
  const places = await workspace()
  try {
    return await body(places)
  } finally {
    await rm(places.base, { recursive: true, force: true })
  }
}

/** A refused destination is a configuration error: exit 2, and stdout stays empty. */
function assertRefused(result) {
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.notEqual(result.stderr, '')
}

test('a symbolic link at the destination is refused, and the file it points at survives', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const victim = join(outside, 'precious.txt')
    await writeFile(victim, 'PRECIOUS\n')
    await symlink(victim, join(root, 'manifest.json'))

    const result = await generate(root, ['--output', 'manifest.json'])

    assertRefused(result)
    assert.match(result.stderr, /symbolic link/)
    assert.equal(await readFile(victim, 'utf8'), 'PRECIOUS\n')
  })
})

test('a symbolic link whose target does not exist yet creates nothing outside the root', async () => {
  await withWorkspace(async ({ root, outside }) => {
    await symlink(join(outside, 'invented.json'), join(root, 'manifest.json'))

    const result = await generate(root, ['--output', 'manifest.json'])

    assertRefused(result)
    assert.deepEqual(await readdir(outside), [], 'the run must not create a file outside the root')
  })
})

test('a symlinked parent directory that leaves the root is refused, which no lexical check catches', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const victim = join(outside, 'manifest.json')
    await writeFile(victim, 'KEEP\n')
    await symlink(outside, join(root, 'link'))

    // Lexically "link/manifest.json" sits under the root. It does not.
    const result = await generate(root, ['--output', 'link/manifest.json'])

    assertRefused(result)
    assert.match(result.stderr, /outside the permitted root/)
    assert.equal(await readFile(victim, 'utf8'), 'KEEP\n')
  })
})

test('a lexical ".." escape is refused', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const result = await generate(root, ['--output', join('..', 'outside', 'manifest.json')])

    assertRefused(result)
    assert.deepEqual(await readdir(outside), [])
  })
})

test('a HARD LINK to a file being hashed is refused, though its path is different', async () => {
  await withWorkspace(async ({ root }) => {
    const input = join(root, 'dist', 'a.txt')
    const alias = join(root, 'manifest.json')
    await link(input, alias)

    // The trap: two names, two different paths, one inode. A path comparison
    // and a realpath comparison both call these different files.
    assert.notEqual(input, alias)
    const [left, right] = [await stat(input), await stat(alias)]
    assert.equal(left.ino, right.ino)

    const result = await generate(root, ['--output', 'manifest.json'])

    assertRefused(result)
    assert.match(result.stderr, /same file as an input/)
    assert.equal(await readFile(input, 'utf8'), 'artifact bytes\n')
  })
})

test('a file that was just hashed is refused as the destination', async () => {
  await withWorkspace(async ({ root }) => {
    const input = join(root, 'dist', 'a.txt')

    const result = await generate(root, ['--output', join('dist', 'a.txt')])

    assertRefused(result)
    assert.equal(await readFile(input, 'utf8'), 'artifact bytes\n')
  })
})

test('a destination that is a directory is refused rather than opened', async () => {
  await withWorkspace(async ({ root }) => {
    await mkdir(join(root, 'build'))

    const result = await generate(root, ['--output', 'build'])

    assertRefused(result)
    assert.match(result.stderr, /not a regular file/)
  })
})

test('ALLOWED: a plain sibling path, an existing subdirectory, and a rewrite of a file that is not an input', async () => {
  await withWorkspace(async ({ root }) => {
    const first = await generate(root, ['--output', 'manifest.json'])
    assert.equal(first.code, 0)
    assert.equal(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')).summary.files, 1)

    await mkdir(join(root, 'build'))
    assert.equal((await generate(root, ['--output', join('build', 'manifest.json')])).code, 0)
    assert.equal(JSON.parse(await readFile(join(root, 'build', 'manifest.json'), 'utf8')).tool, 'artifact-manifest-generator')

    // Writing over the manifest from the previous run is the normal case.
    assert.equal((await generate(root, ['--output', 'manifest.json'])).code, 0)
  })
})

test('ALLOWED: a symlinked directory that stays inside the root, and a directory still to be created', async () => {
  await withWorkspace(async ({ root }) => {
    await mkdir(join(root, 'real-build'))
    await symlink(join(root, 'real-build'), join(root, 'linked-build'))

    assert.equal((await generate(root, ['--output', join('linked-build', 'manifest.json')])).code, 0)
    assert.deepEqual(await readdir(join(root, 'real-build')), ['manifest.json'])
  })
})

test('ALLOWED: an absolute destination outside the working directory when its root is named', async () => {
  await withWorkspace(async ({ root, outside }) => {
    const target = join(outside, 'manifest.json')

    const refused = await generate(root, ['--output', target])
    assertRefused(refused)

    const named = await generate(root, ['--output', target, '--output-root', outside])
    assert.equal(named.code, 0)
    assert.equal(JSON.parse(await readFile(target, 'utf8')).summary.files, 1)
  })
})

test('identity is decided by inode, with the resolved path only as a backstop', () => {
  const inode = (dev, ino) => ({ dev: BigInt(dev), ino: BigInt(ino) })

  // A hard link: one inode, two paths. Only the inode comparison sees it.
  assert.equal(sameFileReason(inode(1, 7), '/a/out.json', inode(1, 7), '/a/input.json'), 'inode')
  // Two different files that happen to sit side by side.
  assert.equal(sameFileReason(inode(1, 7), '/a/out.json', inode(1, 8), '/a/input.json'), null)
  // Same inode number on a different device is a different file.
  assert.equal(sameFileReason(inode(1, 7), '/a/out.json', inode(2, 7), '/a/input.json'), null)

  // A filesystem that reports no inode number at all cannot be asked about
  // identity, and this is the only case the resolved-path backstop decides.
  assert.equal(sameFileReason(inode(1, 0), '/a/input.json', inode(1, 0), '/a/input.json'), 'path')
  assert.equal(sameFileReason(inode(1, 0), '/a/out.json', inode(1, 0), '/a/input.json'), null)
  // An input that could not be stat'ed at all still cannot be written over.
  assert.equal(sameFileReason(inode(1, 7), '/a/input.json', null, '/a/input.json'), 'path')
})
