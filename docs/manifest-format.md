# Manifest format and verification rules

`schemaVersion` is `"1"`.

## Shape

```json
{
  "schemaVersion": "1",
  "tool": "artifact-manifest-generator",
  "summary": { "files": 3, "totalBytes": 152, "symbolicLinks": 0 },
  "files": [{ "path": "assets/mark.svg", "size": 97, "digest": "sha256:…" }],
  "symbolicLinks": [{ "path": "alias.js", "target": "index.mjs" }],
  "build": { "id": "example-build-1" },
  "provenance": { "workflow": "local-example" },
  "digest": "sha256:…"
}
```

`symbolicLinks`, `build` and `provenance` are present only when they apply.

## Determinism

Reproducibility is the whole point, so every ordering decision avoids anything
environment-dependent:

- Paths are root-relative and always use `/`, including on Windows.
- Entries sort by **UTF-16 code unit**, never by locale. `localeCompare`
  depends on ICU data that varies between Node builds and platforms; using it
  would let two correct machines disagree about the order of the same file list
  and therefore about the digest.
- Nothing is inferred. The tool never reads the clock, the environment, or the
  repository. `build` and `provenance` are recorded verbatim from the caller,
  because a manifest that invents its own build identity cannot be checked
  against anything.

## The digest

`digest` covers every path, size and file digest in sorted order, plus any
symbolic link paths and targets. `build` and `provenance` are **excluded**, so
two builds producing identical bytes share a content digest even when their
build metadata differs.

On verification the digest is recomputed from the manifest's own contents. A
mismatch means the manifest was edited after it was written, and is reported as
`manifest-digest-mismatch`.

## Symbolic links

Links are recorded, never traversed. A link resolving outside the artifact root
is refused, because a manifest is evidence about the bytes inside one directory:
a link pointing elsewhere would let it describe, and appear to vouch for,
content the build never produced, and a later verify run on another machine
would resolve it somewhere else. A link that resolves to nothing is refused too,
with its own reason.

## Verification rules

| Rule ID | Severity | Meaning |
| --- | --- | --- |
| `manifest-digest-mismatch` | error | The manifest disagrees with its own recorded digest. |
| `artifact-missing` | error | A recorded artifact is not present. |
| `artifact-modified` | error | An artifact's bytes changed. Evidence carries both digests and both sizes. |
| `artifact-size-mismatch` | error | Size disagrees while the digest matches. |
| `artifact-unexpected` | warning | A file is present that the manifest does not record. |

An unexpected file is a warning rather than an error: extra output is usually a
packaging question, not tampering. It is still reported.

## Limits

| Limit | Default |
| --- | --- |
| Files | 50,000 |
| Total bytes | 8 GiB |
| Directory depth | 64 |

Exceeding a limit is an error, never a silent truncation.
