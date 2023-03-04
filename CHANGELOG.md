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

No release has been published.
