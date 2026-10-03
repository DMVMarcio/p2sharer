# Public repository preparation

## Commit hygiene

Use `pnpm run check:repository` for the tracked working tree and `pnpm run check:repository --staged` for staged additions and modifications. Inspect the complete staged diff, including binary paths and sizes. Run `git diff --cached --check` and a redacted Gitleaks staged scan. The built-in check is a selected-pattern guard, not a guarantee that all secrets or personal information have been detected.

Do not commit logs, runtime captures, machine-specific reports, private environment variants, signing material, generated outputs, or user data. Keep sanitized `.env.example` templates and necessary licensed application assets. Use verified GitHub `noreply` email addresses for new author and committer metadata. Record technical conclusions without identifying participants, private room names, home-directory paths, personal connection measurements, or unnecessary host identifiers.

## Historical audit and rewrite

Include IPv4/IPv6 literals, private hostnames, URL credentials, and deployment identifiers in the audit. The retired deployment directory must remain absent from the current tree and prepared history. Runtime loopback addresses and reviewed public service endpoints are functional configuration, while real server addresses in diagnostic logs are private infrastructure data. Reserved documentation ranges are appropriate examples; browser user-agent version numbers can resemble IP literals and must be distinguished. Reference: [IANA special-purpose IPv4 ranges](https://www.iana.org/assignments/iana-ipv4-special-registry).

Inspect every commit tree across all published branches and tags, and fetch pull-request heads separately. Cache scans by blob ID but associate findings with every containing commit. Audit commit messages and author/committer metadata as well as file contents. Inventory binary sizes and check any archives or unusually large assets manually. A scanner's synthetic-test finding needs a narrow documented explanation; never suppress an entire test directory.

Keep redacted reports, mail mappings, and original-history backups outside the repository. Create and verify a complete Git bundle before rewriting. Prepare the rewrite in an isolated mirror, preserve commit topology and contributor attribution, and compare each branch tip against the intended changes. Verify that application source, required assets, lockfiles, and patches are unchanged by the privacy rewrite. Check the cleaned object graph and re-run secret detection.

Replacing remote history changes commit IDs and requires explicit approval. Push only the reviewed branches/tags with expected old tips, never an unrestricted mirror push from the workspace or audit clone. GitHub pull-request refs cannot be force-pushed; cached PR diffs and commit views may require GitHub Support. Rotate real exposed credentials first, and coordinate existing clones so old commits are not merged back.

## GitHub publication review

Before changing visibility, check Actions history and downloadable logs/artifacts, releases and attachments, issue/PR bodies and comments, forks, and branch protections. Private backups must remain private. History rewriting does not erase existing clones or provider caches. Review the project's license separately: public visibility alone does not grant an open-source license, and license choice must come from the owner.

Reference: [GitHub sensitive-data removal](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) and [repository visibility](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility).
