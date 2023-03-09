import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = resolve(projectDirectory, 'bin/artifact-manifest-generator.mjs')

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: projectDirectory, encoding: 'utf8' })
}

test('generate writes a manifest to stdout and keeps diagnostics off it', () => {
  const result = run(['generate', 'examples/dist'])

  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  assert.doesNotThrow(() => JSON.parse(result.stdout))
})

test('repeated generate runs are byte-identical', () => {
  assert.equal(run(['generate', 'examples/dist']).stdout, run(['generate', 'examples/dist']).stdout)
})

test('the checked-in example manifest still matches its directory', () => {
  const result = run(['verify', 'examples/dist', '--manifest', 'examples/manifest.json'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /status pass/)
})

test('verification of a tampered tree exits one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amg-cli-'))
  try {
    await writeFile(join(directory, 'a.txt'), 'original')
    const manifestPath = join(directory, '..', `manifest-${Date.now() % 100000}.json`)
    const generated = run(['generate', directory])
    await writeFile(manifestPath, generated.stdout)

    await writeFile(join(directory, 'a.txt'), 'tampered')
    const result = run(['verify', directory, '--manifest', manifestPath, '--json'])
    const report = JSON.parse(result.stdout)

    assert.equal(result.status, 1)
    assert.equal(report.status, 'fail')
    assert.ok(report.findings.some((item) => item.ruleId === 'artifact-modified'))
    await rm(manifestPath, { force: true })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a missing directory exits two rather than producing an empty manifest', () => {
  const result = run(['generate', 'examples/does-not-exist'])

  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.notEqual(result.stderr, '')
})

test('verify without --manifest is a usage error', () => {
  const result = run(['verify', 'examples/dist'])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /requires --manifest/)
})

test('an unknown command is a usage error', () => {
  const result = run(['inspect', 'examples/dist'])

  assert.equal(result.status, 2)
  assert.match(result.stderr, /Unknown command "inspect"/)
})

test('--help exits zero', () => {
  const result = run(['--help'])

  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage:/)
})

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

/**
 * A leak is still a leak when the message quotes only the first few characters,
 * so every prefix down to eight characters is checked, not just the whole
 * canary. Eight is short enough to catch V8's ten-character truncation.
 */
function assertNoCanary(streams) {
  for (const [name, text] of Object.entries(streams)) {
    for (let length = CANARY.length; length >= 8; length -= 1) {
      assert.ok(
        !text.includes(CANARY.slice(0, length)),
        `${name} echoed the first ${length} characters of the unparseable file`,
      )
    }
  }
}

test('an unparseable manifest is diagnosed without echoing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amg-leak-'))
  try {
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(manifestPath, CANARY)

    const result = run(['verify', 'examples/dist', '--manifest', manifestPath])

    assert.equal(result.status, 2)
    assertNoCanary({ stdout: result.stdout, stderr: result.stderr })
    assert.match(result.stderr, /not valid JSON/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a truncated manifest still reports where parsing stopped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amg-leak-'))
  try {
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(manifestPath, `{"secret": "${CANARY}", `)

    const result = run(['verify', 'examples/dist', '--manifest', manifestPath])

    assert.equal(result.status, 2)
    assertNoCanary({ stdout: result.stdout, stderr: result.stderr })
    assert.match(result.stderr, /at position \d+ \(line \d+ column \d+\)/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an unparseable --build value is diagnosed without echoing it', () => {
  const result = run(['generate', 'examples/dist', '--build', CANARY])

  assert.equal(result.status, 2)
  assertNoCanary({ stdout: result.stdout, stderr: result.stderr })
  assert.match(result.stderr, /--build requires valid JSON/)
})
