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
- a runnable example artifact directory and its manifest.

### Fixed

- an unparseable manifest, `--build` or `--provenance` value is no longer echoed
  on stderr. V8's parse error quotes the document (`Unexpected token 'A',
  "AKIA..." is not valid JSON`), so a file short enough to be only a credential
  was reproduced in full by its own diagnostic. Position, line and column are
  kept; the quoted content is dropped.

No release has been published.
