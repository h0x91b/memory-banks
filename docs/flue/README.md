# Flue 2.1.0 documentation (vendored, offline)

Unmodified copy of the official Flue documentation for **Flue 2.1.0** — the version pinned in
`package.json` (`@flue/runtime`, `@flue/vite`, `@flue/cli` = `2.1.0`). Kept here so people and
LLM agents can read the docs offline and match them to the version this repo actually runs.

Start with **[INDEX.md](INDEX.md)**: every page with its title and one-line description.

## Provenance

| | |
|---|---|
| Version | Flue 2.1.0 |
| Copied from | `node_modules/@flue/runtime/docs/` of the npm package `@flue/runtime@2.1.0` (`integrity sha512-wFvvoPqtDx8qdtQ2IBkqPiXULpV9C9ZxmY36qnrogbaSJq9u8jrsldAYveMvqpmFpE0AHIe6Iez81/3lmTtiSw==`, as in `package-lock.json`) |
| Upstream source | https://github.com/withastro/flue, `apps/docs/src/content/docs/` |
| Upstream tag / commit | `@flue/runtime@2.1.0` → `767e9a848b1ec0b53b6f637fefd2e0491a7e77f5` |
| Verified | All 95 pages are byte-identical to the files at that commit (same file list, `cmp` per file) |
| Retrieved | 2026-10-03 |
| Website | https://flueframework.com/docs/ — tracks the latest release, which may differ from 2.1.0 |

`SHA256SUMS` lists checksums of the vendored pages: `cd docs/flue && shasum -a 256 -c SHA256SUMS`.

## License and attribution

Flue is © its authors (the `withastro/flue` project) and licensed under the Apache License 2.0;
the documentation ships inside the Apache-2.0 npm package. The license text is in [LICENSE](LICENSE).
The pages are copied without modification; only `README.md`, `INDEX.md` and `SHA256SUMS` were added here.

## Reading notes

- Pages are Markdown (`.md`, two are `.mdx`) with YAML front matter (`title`, `description`, `lastReviewedAt`).
- Cross-links use site paths: `/docs/<path>/` maps to `docs/flue/<path>.md` (or `.mdx`) here,
  e.g. `/docs/guide/subagents/` → [guide/subagents.md](guide/subagents.md). Anchors (`#...`) stay valid.
  The one exception is `/docs/ecosystem/`, a site-only landing page with no Markdown source; see the
  `ecosystem` section of [INDEX.md](INDEX.md) instead.
- `.mdx` pages import site-only Astro components (`CopyPrompt`); ignore those lines.
- The same pages are also available from the installed CLI: `npx flue docs`, `npx flue docs search <query>`,
  `npx flue docs read <path>` (see [cli/docs.md](cli/docs.md)).

## Updating

There is no automatic sync. When the Flue version in `package.json` changes, replace the page
directories with the new package's `docs/` folder and regenerate `INDEX.md`, `SHA256SUMS` and the
provenance table above.
