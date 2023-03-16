# Artifact Manifest Generator

Create a deterministic manifest of files, hashes, versions and provenance — and
verify a directory against one.

- **Repository:** [edilec/artifact-manifest-generator](https://github.com/edilec/artifact-manifest-generator)
- **Area:** DevOps & Release
- **License:** MIT

## Why it exists

Between building an artifact and shipping it, plenty can change it: a partial
copy, a stray log file, a rerun that quietly produced different bytes. A
manifest pins exactly what the build produced, so a later step can prove the
directory still holds it.

The manifest is designed to be reproducible: hash the same bytes on any machine
and you get the same digest.

## Requirements

- Node.js 22 or newer
- no runtime dependencies

## Quick start

```sh
# record what the build produced
node bin/artifact-manifest-generator.mjs generate ./dist \
  --build '{"id":"build-42","revision":"abc123"}' \
  --output dist-manifest.json

# later, prove the directory still holds it
node bin/artifact-manifest-generator.mjs verify ./dist --manifest dist-manifest.json
```

A tampered file fails with both digests:

```text
ERROR   index.js Artifact contents changed since the manifest was written.

3 artifact(s): 1 error, 0 warning, status fail.
```

## What determinism means here

Reproducibility is the whole point, so every ordering decision avoids anything
environment-dependent:

- Paths are root-relative and always use `/`, including on Windows.
- Entries sort by **UTF-16 code unit, never by locale**. `localeCompare`
  depends on ICU data that varies between Node builds and platforms; using it
  would let two correct machines disagree about the order of the same file list
  and therefore about the digest.
- Nothing is inferred. The tool never reads the clock, the environment or the
  repository. `--build` and `--provenance` are recorded verbatim, because a
  manifest that invents its own build identity cannot be checked against
  anything.

`digest` covers paths, sizes and file digests. `build` and `provenance` are
**excluded**, so two builds producing identical bytes share a content digest
even when their build metadata differs.

## Symbolic links

Links are recorded, never traversed. A link that resolves **outside** the
artifact root is refused: a manifest is evidence about the bytes inside one
directory, and a link pointing elsewhere would let it appear to vouch for
content the build never produced — resolving somewhere else entirely on the next
machine. A link that resolves to nothing is refused too, with its own reason.

## Where the manifest may be written

`--output` is checked before a single byte is written, because this tool once
destroyed two files it was never asked to touch and exited 0 both times printing
`Wrote 1 artifact(s)`. Three independent holes, and guarding one or two is what
most tools that lost data had already done:

| Refused | Why the obvious guard misses it |
| --- | --- |
| a **symbolic link at the destination** | `realpath` on the destination *resolves* the link, and resolving is the dangerous act, so the link is refused on sight with `lstat` before anything is opened. A link whose target does not exist yet is the same hole: following it creates a brand new file outside the root. |
| a **symlinked parent directory** | a lexical prefix check passes for `root/link/out` where `link` leaves the root, so the parent is resolved and then compared. |
| a **hard link to a file being hashed** | it has no target to resolve and shares no path with the file, so `realpath` and string comparison both call it a different file. Only device plus inode sees that it is one file. |

A destination that resolves outside the output root — the working directory,
unless `--output-root DIR` names another — is refused as well. A refused
destination is a configuration error: **nothing is written, stdout stays empty
and the exit code is 2**.

Destinations that must still work, and are pinned by the same test file: a plain
path, a subdirectory, a directory under a symbolic link that stays inside the
root, a rewrite of the manifest from a previous run, and an absolute path
outside the working directory once `--output-root` names the root it belongs to.

## Library usage

```js
import { generateManifest, verifyManifest } from 'artifact-manifest-generator'

const manifest = await generateManifest('./dist', { build: { id: 'build-42' } })
const report = await verifyManifest('./dist', manifest)
```

## Verification rules

| Rule ID | Severity | Meaning |
| --- | --- | --- |
| `manifest-digest-mismatch` | error | The manifest disagrees with its own recorded digest. |
| `artifact-missing` | error | A recorded artifact is not present. |
| `artifact-modified` | error | An artifact's bytes changed. |
| `artifact-size-mismatch` | error | Size disagrees while the digest matches. |
| `artifact-unexpected` | warning | A file is present that the manifest does not record. |

An unexpected file is a warning, not an error: extra output is usually a
packaging question rather than tampering. It is still reported.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | manifest written, or verification passed |
| `1` | verification failed |
| `2` | invalid usage, a refused output destination, or the directory could not be read |

## Diagnostics never quote the input

A manifest that fails to parse is reported by position, never by content:
`Manifest build/manifest.json is not valid JSON: Expected ',' or '}' after
property value in JSON at position 37 (line 1 column 38)`. V8's own parse error
quotes the document it choked on, so a manifest short enough to be only a
credential would otherwise be reproduced in full on stderr. The quoted half is
stripped; the position, line and column survive. The same holds for `--build`
and `--provenance` values.

## Limits and non-goals

- Defaults: 50,000 files, 8 GiB total, 64 directory levels. Exceeding a limit is
  an error, never a silent truncation.
- This is **not** a signing tool. A manifest proves a directory matches a
  recorded file set; it says nothing about who produced it or whether they were
  authorised to. Pair it with a signature over the manifest if you need that.
- `provenance` is recorded, not validated. The tool does not resolve an
  attestation reference or check that it exists.
- File modes, ownership and timestamps are not recorded, so a mode change alone
  will not be detected.
- Empty directories are not recorded, because the manifest describes files.

## Development

```sh
npm test          # behaviour tests
npm run check     # lint, tests, runnable example, packaging check
```

## License

MIT. See [LICENSE](./LICENSE).
