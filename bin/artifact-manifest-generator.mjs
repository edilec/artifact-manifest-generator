#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { formatReport, generateManifest, parseFailureDetail, verifyManifest } from '../src/index.mjs'

const HELP = `artifact-manifest-generator

Create a deterministic manifest of an artifact directory, and verify one.

Usage:
  artifact-manifest-generator generate <DIR> [--output FILE] [--build JSON] [--provenance JSON]
  artifact-manifest-generator verify   <DIR> --manifest FILE [--json]

Options:
  --output FILE       Write the manifest here instead of stdout
  --build JSON        Build identity recorded verbatim in the manifest
  --provenance JSON   Provenance references recorded verbatim in the manifest
  --manifest FILE     Manifest to verify the directory against
  --json              Emit the machine-readable verification report
  -h, --help          Show this help

Exit codes:
  0  manifest written, or verification passed
  1  verification failed
  2  invalid usage, or the directory could not be read
`

function parseArguments(argv) {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') return { help: true }

  const [command, ...rest] = argv
  if (command !== 'generate' && command !== 'verify') {
    throw new Error(`Unknown command "${command}"; expected generate or verify`)
  }

  const options = { command, directory: null, output: null, manifest: null, json: false, build: undefined, provenance: undefined }

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
        await writeFile(resolve(options.output), serialized)
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
