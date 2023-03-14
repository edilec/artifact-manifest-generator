import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export const TOOL_ID = 'artifact-manifest-generator'
export const MANIFEST_SCHEMA_VERSION = '1'
export const REPORT_SCHEMA_VERSION = '1'

export const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 50_000,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxDepth: 64,
})

/**
 * Why symlinks are refused rather than followed.
 *
 * A manifest is evidence about the bytes inside one directory. A symlink that
 * resolves outside the root would let the manifest describe -- and appear to
 * vouch for -- content the build never produced, and a later verify run on a
 * different machine would resolve it somewhere else entirely. Links are
 * recorded, never traversed, and one pointing outside the root is an error.
 */
function toPosix(value) {
  return value.split(sep).join('/')
}

/**
 * Order by UTF-16 code unit, deliberately not by locale.
 *
 * A manifest digest has to be identical on every machine that hashes the same
 * bytes. `localeCompare` depends on ICU data that varies between Node builds
 * and platforms, so using it here would let two correct machines disagree about
 * the order of the same file list, and therefore about the digest.
 */
function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/

/**
 * The shape that quotes the input. The `s` flag matters: the quoted span can
 * contain a newline. A leading `...` means the quoted run came from the middle
 * of the document rather than its start.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Describe a JSON parse failure without repeating the document.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A manifest
 * short enough to be only a credential is therefore reproduced in full by its
 * own error message, so interpolating that message into a diagnostic would
 * defeat every other precaution. The position is the useful half and is safe;
 * the quoted half is the input and never leaves this function.
 *
 * The quoting shape is recognised FIRST, before the position is looked for: a
 * manifest whose own text reads `at position 1` is quoted back by V8, so a
 * search for the position finds that text inside the quoted span and slices
 * the manifest straight out again. V8 omits the position from the quoting
 * form, so that case reports the offending token and whether the quoted run
 * started at the beginning of the document rather than inventing a location.
 *
 * The closing guard is what extends all of this to wordings this function has
 * never seen: every V8 parse message that carries no quoted snippet quotes
 * JSON punctuation with apostrophes and holds no double quote at all, so a
 * double quote surviving to the end means a snippet survived with it.
 */
export function parseFailureDetail(error) {
  const message = String(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

async function hashFile(path) {
  const digest = createHash('sha256')
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => digest.update(chunk))
    stream.on('error', rejectHash)
    stream.on('end', resolveHash)
  })
  return `sha256:${digest.digest('hex')}`
}

class ScanError extends Error {}

async function walk(root, directory, limits, state, depth) {
  if (depth > limits.maxDepth) {
    throw new ScanError(`Directory nesting exceeds the configured depth limit of ${limits.maxDepth}`)
  }

  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of [...entries].sort((left, right) => byCodeUnit(left.name, right.name))) {
    const absolute = join(directory, entry.name)
    const relativePath = toPosix(relative(root, absolute))
    const stats = await lstat(absolute)

    if (stats.isSymbolicLink()) {
      const target = await readlink(absolute)
      const resolved = await realpath(absolute).catch(() => null)

      if (resolved === null) {
        throw new ScanError(`Symbolic link "${relativePath}" does not resolve to anything`)
      }
      if (resolved !== root && !resolved.startsWith(root + sep)) {
        throw new ScanError(
          `Symbolic link "${relativePath}" resolves outside the artifact root; refusing to describe content the build did not produce`,
        )
      }
      state.links.push({ path: relativePath, target: toPosix(target) })
      continue
    }

    if (stats.isDirectory()) {
      await walk(root, absolute, limits, state, depth + 1)
      continue
    }

    if (!stats.isFile()) {
      throw new ScanError(`"${relativePath}" is not a regular file, directory or symbolic link`)
    }

    state.totalBytes += stats.size
    if (state.files.length >= limits.maxFiles) {
      throw new ScanError(`Artifact directory exceeds the configured limit of ${limits.maxFiles} files`)
    }
    if (state.totalBytes > limits.maxTotalBytes) {
      throw new ScanError(`Artifact directory exceeds the configured total size limit of ${limits.maxTotalBytes} bytes`)
    }

    state.files.push({
      path: relativePath,
      size: stats.size,
      digest: await hashFile(absolute),
    })
  }
}

/**
 * Hash an artifact directory into a deterministic manifest.
 *
 * `build` and `provenance` are recorded verbatim from the caller. Nothing is
 * inferred: the tool does not read the clock, the environment, or the
 * repository, because a manifest that invents its own build identity cannot be
 * checked against anything.
 */
export async function generateManifest(rootPath, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  const root = await realpath(resolve(rootPath))
  const state = { files: [], links: [], totalBytes: 0 }

  await walk(root, root, limits, state, 0)

  state.files.sort((left, right) => byCodeUnit(left.path, right.path))
  state.links.sort((left, right) => byCodeUnit(left.path, right.path))

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: TOOL_ID,
    summary: {
      files: state.files.length,
      totalBytes: state.totalBytes,
      symbolicLinks: state.links.length,
    },
    files: state.files,
  }
  if (state.links.length > 0) manifest.symbolicLinks = state.links
  if (options.build !== undefined) manifest.build = options.build
  if (options.provenance !== undefined) manifest.provenance = options.provenance

  manifest.digest = manifestDigest(manifest)
  return manifest
}

/**
 * Fingerprint of the file set alone.
 *
 * Covers every path, size and digest in sorted order. Build identity and
 * provenance are deliberately excluded, so two builds of identical bytes carry
 * the same content digest even when their build metadata differs.
 */
export function manifestDigest(manifest) {
  const digest = createHash('sha256')
  for (const file of manifest.files) {
    digest.update(`${file.path}\u0000${file.size}\u0000${file.digest}\n`)
  }
  for (const link of manifest.symbolicLinks ?? []) {
    digest.update(`link\u0000${link.path}\u0000${link.target}\n`)
  }
  return `sha256:${digest.digest('hex')}`
}

function finding(ruleId, severity, message, file, extra = {}) {
  return { ruleId, severity, message, location: { file }, ...extra }
}

/**
 * Verify a directory against a manifest.
 *
 * A file the manifest does not mention is a warning, not an error: extra output
 * is usually a packaging question rather than tampering. Changed bytes and
 * missing artifacts are errors.
 */
export async function verifyManifest(rootPath, manifest, options = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Manifest must be an object')
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported manifest schemaVersion: ${manifest.schemaVersion ?? 'missing'}`)
  }
  if (!Array.isArray(manifest.files)) throw new TypeError('Manifest is missing its files array')

  const recorded = manifestDigest(manifest)
  const declared = manifest.digest
  const findings = []

  if (declared !== undefined && declared !== recorded) {
    findings.push(finding(
      'manifest-digest-mismatch',
      'error',
      'The manifest does not match its own recorded digest; it was edited after it was written.',
      null,
      { evidence: { declared, recomputed: recorded } },
    ))
  }

  const current = await generateManifest(rootPath, { limits: options.limits })
  const currentByPath = new Map(current.files.map((file) => [file.path, file]))
  const manifestPaths = new Set(manifest.files.map((file) => file.path))

  for (const expected of manifest.files) {
    const actual = currentByPath.get(expected.path)
    if (!actual) {
      findings.push(finding('artifact-missing', 'error', 'Artifact recorded in the manifest is not present.', expected.path))
      continue
    }
    if (actual.digest !== expected.digest) {
      findings.push(finding(
        'artifact-modified',
        'error',
        'Artifact contents changed since the manifest was written.',
        expected.path,
        { evidence: { expected: expected.digest, actual: actual.digest, expectedSize: expected.size, actualSize: actual.size } },
      ))
    } else if (actual.size !== expected.size) {
      findings.push(finding('artifact-size-mismatch', 'error', 'Artifact size disagrees with the manifest.', expected.path))
    }
  }

  for (const file of current.files) {
    if (!manifestPaths.has(file.path)) {
      findings.push(finding('artifact-unexpected', 'warning', 'File is present but not recorded in the manifest.', file.path))
    }
  }

  findings.sort((left, right) =>
    byCodeUnit(String(left.location.file ?? ''), String(right.location.file ?? ''))
    || byCodeUnit(left.ruleId, right.ruleId))

  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.length - errors

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: errors > 0 ? 'fail' : 'pass',
    summary: {
      checked: manifest.files.length,
      errors,
      warnings,
      manifestDigest: declared ?? null,
      observedDigest: current.digest,
    },
    findings,
  }
}

export function formatReport(report) {
  const lines = report.findings.map((item) =>
    `${item.severity.toUpperCase().padEnd(7)} ${item.location.file ?? '(manifest)'} ${item.message}`)
  lines.push('')
  lines.push(
    `${report.summary.checked} artifact(s): ${report.summary.errors} error, `
    + `${report.summary.warnings} warning, status ${report.status}.`,
  )
  return `${lines.join('\n')}\n`
}

export { DestinationError, assertWritableDestination } from './destination.mjs'
export { ScanError }
