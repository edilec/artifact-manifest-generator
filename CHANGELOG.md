# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- `generateManifest`, hashing a bounded artifact directory into a deterministic
  manifest of root-relative paths, sizes and SHA-256 digests;
- `verifyManifest`, reporting missing, modified, resized and unexpected files,
  and catching a manifest edited after it was written via its own digest;
- verbatim `build` and `provenance` fields, excluded from the content digest so
  identical bytes share a digest across builds;
- symbolic links recorded but never traversed, with links resolving outside the
  artifact root refused;
- bounded traversal with file-count, total-size and depth limits;
- a CLI with `generate` and `verify`, `--json`, and exit codes 0 / 1 / 2;
- `--output-root DIR`, naming the directory `--output` may write inside; it
  defaults to the working directory;
- a runnable example artifact directory and its manifest.

### Fixed

- `--output` no longer destroys a file it was never asked to touch. A symbolic
  link at the destination wrote the manifest wherever the link pointed, a
  symlinked parent directory carried it outside the root a lexical check said it
  was inside, and a hard link to a file the run had just hashed was overwritten
  because it shares no path with the file it names — all three exiting 0 and
  reporting `Wrote 1 artifact(s)`. The destination is now checked with `lstat`,
  a resolved parent and a device-plus-inode identity comparison before the first
  write, and a refused destination is a configuration error: nothing is written,
  stdout stays empty, exit code 2.
- an unparseable manifest, `--build` or `--provenance` value is no longer echoed
  on stderr. V8's parse error quotes the document (`Unexpected token 'A',
  "AKIA..." is not valid JSON`), so a file short enough to be only a credential
  was reproduced in full by its own diagnostic. Position, line and column are
  kept; the quoted content is dropped.

No release has been published.
