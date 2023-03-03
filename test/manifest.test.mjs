import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  MANIFEST_SCHEMA_VERSION,
  ScanError,
  generateManifest,
  manifestDigest,
  verifyManifest,
} from '../src/index.mjs'

async function withTree(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'artifact-manifest-'))
  try {
    for (const [path, contents] of Object.entries(files)) {
      const absolute = join(root, path)
      await mkdir(join(absolute, '..'), { recursive: true })
      await writeFile(absolute, contents)
    }
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const TREE = {
  'index.js': 'console.log(1)\n',
  'assets/logo.svg': '<svg/>\n',
  'assets/nested/deep.txt': 'deep\n',
}

test('the same files yield the same manifest', async () => {
  const first = await withTree(TREE, (root) => generateManifest(root))
  const second = await withTree(TREE, (root) => generateManifest(root))

  assert.equal(first.digest, second.digest)
  assert.deepEqual(first.files, second.files)
  assert.equal(first.summary.files, 3)
})

test('paths are root-relative, POSIX-separated and sorted', async () => {
  const manifest = await withTree(TREE, (root) => generateManifest(root))

  assert.deepEqual(
    manifest.files.map((file) => file.path),
    ['assets/logo.svg', 'assets/nested/deep.txt', 'index.js'],
  )
  assert.equal(manifest.files.every((file) => !file.path.startsWith('/')), true)
})

test('each entry records a size and a sha256 digest', async () => {
  const manifest = await withTree({ 'a.txt': 'hello' }, (root) => generateManifest(root))

  assert.equal(manifest.files[0].size, 5)
  assert.match(manifest.files[0].digest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(manifest.summary.totalBytes, 5)
})

test('build identity and provenance are recorded verbatim and excluded from the content digest', async () => {
  await withTree(TREE, async (root) => {
    const plain = await generateManifest(root)
    const labelled = await generateManifest(root, {
      build: { id: 'build-42', revision: 'abc123' },
      provenance: { workflow: 'release', attestation: 'sha256:dead' },
    })

    assert.deepEqual(labelled.build, { id: 'build-42', revision: 'abc123' })
    assert.deepEqual(labelled.provenance, { workflow: 'release', attestation: 'sha256:dead' })
    assert.equal(labelled.digest, plain.digest, 'identical bytes must share a content digest')
  })
})

test('nothing is inferred: no clock or environment leaks into the manifest', async () => {
  const manifest = await withTree(TREE, (root) => generateManifest(root))
  const serialized = JSON.stringify(manifest)

  assert.equal(manifest.build, undefined)
  assert.equal(manifest.provenance, undefined)
  assert.doesNotMatch(serialized, /\d{4}-\d{2}-\d{2}T/)
})

test('a symlink inside the root is recorded, never traversed', async () => {
  await withTree(TREE, async (root) => {
    await symlink(join(root, 'index.js'), join(root, 'alias.js'))
    const manifest = await generateManifest(root)

    assert.equal(manifest.summary.symbolicLinks, 1)
    assert.equal(manifest.symbolicLinks[0].path, 'alias.js')
    assert.equal(manifest.files.some((file) => file.path === 'alias.js'), false)
  })
})

test('a symlink escaping the root is refused', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'artifact-outside-'))
  try {
    await writeFile(join(outside, 'secret.txt'), 'not ours\n')
    await withTree(TREE, async (root) => {
      await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
      await assert.rejects(generateManifest(root), (error) => {
        assert.ok(error instanceof ScanError)
        assert.match(error.message, /resolves outside the artifact root/)
        return true
      })
    })
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('a symlink to a directory outside the root is refused', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'artifact-outside-dir-'))
  try {
    await writeFile(join(outside, 'a.txt'), 'x')
    await withTree(TREE, async (root) => {
      await symlink(outside, join(root, 'linked-dir'))
      await assert.rejects(generateManifest(root), /resolves outside the artifact root/)
    })
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('a broken symlink is refused with its own reason', async () => {
  await withTree(TREE, async (root) => {
    await symlink(join(root, 'no-such-file'), join(root, 'dangling'))
    await assert.rejects(generateManifest(root), /does not resolve to anything/)
  })
})

test('an unchanged tree verifies clean', async () => {
  await withTree(TREE, async (root) => {
    const manifest = await generateManifest(root)
    const report = await verifyManifest(root, manifest)

    assert.equal(report.status, 'pass')
    assert.deepEqual(report.findings, [])
    assert.equal(report.summary.observedDigest, manifest.digest)
  })
})

test('tampered bytes fail verification with both digests', async () => {
  await withTree(TREE, async (root) => {
    const manifest = await generateManifest(root)
    await writeFile(join(root, 'index.js'), 'console.log(2)\n')

    const report = await verifyManifest(root, manifest)
    const finding = report.findings.find((item) => item.location.file === 'index.js')

    assert.equal(report.status, 'fail')
    assert.equal(finding.ruleId, 'artifact-modified')
    assert.notEqual(finding.evidence.expected, finding.evidence.actual)
  })
})

test('a missing artifact fails verification', async () => {
  await withTree(TREE, async (root) => {
    const manifest = await generateManifest(root)
    await rm(join(root, 'assets/logo.svg'))

    const report = await verifyManifest(root, manifest)

    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some(
      (item) => item.ruleId === 'artifact-missing' && item.location.file === 'assets/logo.svg',
    ))
  })
})

test('an unexpected extra file is a warning, not a failure', async () => {
  await withTree(TREE, async (root) => {
    const manifest = await generateManifest(root)
    await writeFile(join(root, 'extra.log'), 'noise\n')

    const report = await verifyManifest(root, manifest)
    const finding = report.findings.find((item) => item.location.file === 'extra.log')

    assert.equal(finding.ruleId, 'artifact-unexpected')
    assert.equal(finding.severity, 'warning')
    assert.equal(report.status, 'pass')
  })
})

test('an edited manifest is caught by its own digest', async () => {
  await withTree(TREE, async (root) => {
    const manifest = await generateManifest(root)
    manifest.files[0].digest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'

    const report = await verifyManifest(root, manifest)

    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((item) => item.ruleId === 'manifest-digest-mismatch'))
  })
})

test('verification rejects a manifest it does not understand', async () => {
  await withTree(TREE, async (root) => {
    await assert.rejects(verifyManifest(root, null), /must be an object/)
    await assert.rejects(verifyManifest(root, { schemaVersion: '9', files: [] }), /Unsupported manifest schemaVersion/)
    await assert.rejects(verifyManifest(root, { schemaVersion: MANIFEST_SCHEMA_VERSION }), /missing its files array/)
  })
})

test('the file limit is enforced', async () => {
  const files = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => [`file-${index}.txt`, 'x']),
  )
  await withTree(files, async (root) => {
    await assert.rejects(
      generateManifest(root, { limits: { maxFiles: 3 } }),
      /exceeds the configured limit of 3 files/,
    )
  })
})

test('the total size limit is enforced', async () => {
  await withTree({ 'big.bin': 'x'.repeat(1024) }, async (root) => {
    await assert.rejects(
      generateManifest(root, { limits: { maxTotalBytes: 100 } }),
      /total size limit/,
    )
  })
})

test('the depth limit is enforced', async () => {
  await withTree({ 'a/b/c/d.txt': 'deep' }, async (root) => {
    await assert.rejects(generateManifest(root, { limits: { maxDepth: 2 } }), /depth limit/)
  })
})

test('the digest covers paths, sizes and link targets', () => {
  const base = {
    files: [{ path: 'a.txt', size: 1, digest: 'sha256:aa' }],
  }
  const renamed = { files: [{ path: 'b.txt', size: 1, digest: 'sha256:aa' }] }
  const resized = { files: [{ path: 'a.txt', size: 2, digest: 'sha256:aa' }] }
  const linked = { ...base, symbolicLinks: [{ path: 'l', target: 'a.txt' }] }

  assert.notEqual(manifestDigest(base), manifestDigest(renamed))
  assert.notEqual(manifestDigest(base), manifestDigest(resized))
  assert.notEqual(manifestDigest(base), manifestDigest(linked))
})

test('ordering is by code unit, not by locale', async () => {
  // Uppercase sorts before lowercase by code unit. A locale-aware comparator
  // would interleave these, and two machines with different ICU data would then
  // disagree about the digest for identical bytes.
  await withTree({ 'README.txt': 'a', 'assets/x.txt': 'b', 'index.mjs': 'c' }, async (root) => {
    const manifest = await generateManifest(root)

    assert.deepEqual(
      manifest.files.map((file) => file.path),
      ['README.txt', 'assets/x.txt', 'index.mjs'],
    )
  })
})

test('unicode paths order consistently and round-trip through verification', async () => {
  await withTree({ 'Ä.txt': 'a', 'z.txt': 'b', 'é.txt': 'c' }, async (root) => {
    const manifest = await generateManifest(root)
    const report = await verifyManifest(root, manifest)

    assert.equal(report.status, 'pass')
    assert.deepEqual(manifest.files.map((file) => file.path), ['z.txt', 'Ä.txt', 'é.txt'])
  })
})
