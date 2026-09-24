# Releasing Crabfleet

The tag-driven `.github/workflows/release.yml` publishes Linux amd64 and arm64
`crabfleet-connect` archives plus `checksums.txt` with GoReleaser. The connector
version comes from the tag through the build linker flags; the private Node
package and experimental Rust workspace do not use that version. Native Mac
and Windows binaries are not packaged by this workflow.

1. Run the gates in `AGENTS.md` and review the changes. Use a patch version for
   fixes, or a minor version for features and compatibility requirement changes.
2. Finalize the changelog as `## X.Y.Z - YYYY-MM-DD` with a highlights lead-in,
   preserving contributor credit. Keep an empty `## Unreleased` section above it.
3. Verify the exact notes with
   `node scripts/release-notes.mjs vX.Y.Z CHANGELOG.md`.
4. Land the release preparation PR after its exact-head CI passes, then tag that
   main commit with `git tag vX.Y.Z` and `git push origin vX.Y.Z`.
5. Wait for the release workflow. Verify the published, non-draft GitHub Release
   body matches the changelog section, both connector archives and checksums are
   present, and the downloaded Linux executable reports the tagged version.
   Verify the Go module version through the public Go proxy as well.

For a retry, dispatch the release workflow from main with its `tag` input. It
checks out that tag before selecting Go, extracts that tag's changelog, and uses
that tag's GoReleaser configuration. Missing, empty, or duplicate changelog
sections fail before publication. After GoReleaser uploads the artifacts, the
workflow applies the extracted notes with the GitHub CLI; this also handles
older tags whose GoReleaser configuration disables changelog generation.
Run release commands only with the
maintainer's explicit release authorization.
