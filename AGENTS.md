# Project Instructions

- Worktrees are not needed in this repo unless explicitly requested.
- The root `@mblarsen/pi-extensions` package is private. Never publish it.
- Each directory under `packages/` is an independently versioned public npm package.
- Use npm workspaces. Do not add a second package manager or lockfile.

## Changesets

Use Changesets for every change that must produce a new npm package version.

Add one `.changeset/<short-slug>.md` file with this format:

```md
---
"@mblarsen/pi-task-ui": minor
---

Add task labels to the sidebar.
```

Use these version bumps:

- `patch`: backward-compatible fixes, package documentation updates, and internal improvements that affect the published package.
- `minor`: backward-compatible features or new commands, tools, and options.
- `major`: breaking behavior, removed features, or incompatible configuration changes.

List all affected packages in one changeset when one change spans several packages. Each package can use a different bump.

Write the changeset summary for package users. State what changed. Do not describe the implementation process.

Do not add a changeset for root-only CI, repository documentation, or development tooling changes. Do not edit workspace package versions or changelogs manually. The Changesets version PR owns those files.

Before committing a package change, run:

```bash
npm ci
npm run check
npx changeset status
```

Make sure `npm run pack:check` includes each declared Pi extension and Agent Skill. It must exclude tests.

## Release requests

Interpret release requests as follows:

- **“Prepare a release”**: add or verify the changeset, run all checks, commit, push, and open a PR to `main`.
- **“Publish the pending release”**: inspect the Changesets version PR, confirm its versions and changelogs, merge it, monitor the `Release` workflow, and verify every new version on npm.
- **“Release this change end to end”**: prepare the change PR first. After it merges, publish the resulting Changesets version PR.

Use `gh pr` for all pull requests. Use `gh pr create --body-file <path>` for PR descriptions.

The `Release` workflow on `main` has two modes:

1. If unreleased changesets exist, it creates or updates the Changesets version PR.
2. If the version PR was merged, it publishes the new package versions with npm trusted publishing.

Publishing and merging a version PR are irreversible release actions. Get explicit confirmation immediately before either action unless Michael already gave exact permission for that release.

After publishing, verify each expected version:

```bash
npm view @mblarsen/pi-task-ui version
```

Report the version PR, published package names, versions, workflow result, and any package that did not publish.

## First publication of a package

A new npm package must exist before npm trusted publishing can be configured. The release workflow skips Changesets until `@mblarsen/pi-burn-more-tokens` exists, so the initial migration can merge before manual publication.

1. Confirm that the package name is available.
2. Run `npm run check`.
3. Get explicit confirmation to create the public package.
4. Publish only that workspace with `npm publish --workspace <package-name> --access public`.
5. Configure its GitHub trusted publisher for `.github/workflows/release.yml`.
6. Verify the package with `npm view <package-name> version`.

Never request an npm password, one-time password, recovery code, or token in chat. Ask Michael to run `npm login` in his terminal when local npm authentication is required.
