#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  assertWritableDestination,
  formatReport,
  generateManifest,
  parseFailureDetail,
  verifyManifest,
} from '../src/index.mjs'

const HELP = `artifact-manifest-generator

Create a deterministic manifest of an artifact directory, and verify one.

Usage:
  artifact-manifest-generator generate <DIR> [--output FILE] [--build JSON] [--provenance JSON]
  artifact-manifest-generator verify   <DIR> --manifest FILE [--json]

Options:
  --output FILE       Write the manifest here instead of stdout. The
                      destination is refused if it is a symbolic link, if it
                      resolves outside the output root, or if it is one of the
                      files being hashed -- including through a hard link,
                      which shares no path with the file it names.
  --output-root DIR   Directory the manifest may be written inside
                      (default: the working directory)
  --build JSON        Build identity recorded verbatim in the manifest
  --provenance JSON   Provenance references recorded verbatim in the manifest
  --manifest FILE     Manifest to verify the directory against
  --json              Emit the machine-readable verification report
  -h, --help          Show this help

Exit codes:
  0  manifest written, or verification passed
  1  verification failed
  2  invalid usage, a refused output destination (stdout stays empty and
     nothing is written), or the directory could not be read
`

function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') return { help: true }

  const [command, ...rest] = argv
  if (command !== 'generate' && command !== 'verify') {
    throw new Error(`Unknown command "${command}"; expected generate or verify`)
  }

  const options = { command, directory: null, output: null, outputRoot: null, manifest: null, json: false, build: undefined, provenance: undefined }

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    const takeValue = (name) => {
      const value = rest[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    const takeJson = (name) => {
      const value = takeValue(name)
      try {
        return JSON.parse(value)
      } catch (error) {
        throw new Error(`${name} requires valid JSON: ${parseFailureDetail(error)}`)
      }
    }

    if (argument === '--json') options.json = true
    else if (argument === '--output') options.output = takeValue('--output')
    else if (argument === '--output-root') options.outputRoot = takeValue('--output-root')
    else if (argument === '--manifest') options.manifest = takeValue('--manifest')
    else if (argument === '--build') options.build = takeJson('--build')
    else if (argument === '--provenance') options.provenance = takeJson('--provenance')
    else if (argument.startsWith('-')) throw new Error(`Unknown option "${argument}"`)
    else if (options.directory === null) options.directory = argument
    else throw new Error('Provide exactly one directory')
  }

  if (options.directory === null) throw new Error('Provide an artifact directory')
  if (options.command === 'verify' && options.manifest === null) throw new Error('verify requires --manifest')
  return options
}

async function readManifest(path, label) {
  const text = await readFile(path, 'utf8')
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Manifest ${label} is not valid JSON: ${parseFailureDetail(error)}`)
  }
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }

  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  try {
    if (options.command === 'generate') {
      const manifest = await generateManifest(options.directory, {
        build: options.build,
        provenance: options.provenance,
      })
      const serialized = `${JSON.stringify(manifest, null, 2)}\n`
      if (options.output) {
        /**
         * The destination is settled before the first byte is written.
         *
         * Every file just hashed is named as an input, because the manifest is
         * derived from them and writing it over one destroys the evidence the
         * run was asked to describe -- which this tool did, exiting 0 and
         * reporting the write. A hard link to one of those files shares no
         * path with it, so identity is decided by device and inode.
         */
        const destination = await assertWritableDestination(options.output, {
          inputs: manifest.files.map((file) => resolve(options.directory, ...file.path.split('/'))),
          root: options.outputRoot ?? process.cwd(),
          label: '--output',
        })
        await writeFile(destination, serialized)
        process.stderr.write(`Wrote ${manifest.summary.files} artifact(s) to ${options.output}\n`)
      } else {
        process.stdout.write(serialized)
      }
      return 0
    }

    const manifest = await readManifest(resolve(options.manifest), options.manifest)
    const report = await verifyManifest(options.directory, manifest)
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
    return report.status === 'fail' ? 1 : 0
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }
}

process.exitCode = await main(process.argv.slice(2))
