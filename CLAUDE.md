# CLAUDE.md

The ops Worker of CandleStack (STU FEI team project): uptime checks, the status page at
`ops.candlestack.tech` and their history in D1, on Cloudflare. Read [README.md](README.md) first;
its agent contract is shared with `infra/agent/` in the candlestack repository.

## Rules

- Everything in English: code, comments, docs, commit messages, pull requests.
- Branch from `main` as `<area>/<topic>`; one small pull request per topic. Its title becomes
  the squash commit: imperative, sentence case, no trailing period.
- No AI attribution anywhere: no `Co-Authored-By` trailers of AI tools, no "Generated with ..."
  lines, no session links in commits or pull requests. The `no-ai-signs` check fails on them;
  `.claude/settings.json` already turns Claude Code's attribution off.
- Every path belongs to the tech lead (`.github/CODEOWNERS`): a change needs their approval to merge.
- Every push to `main` deploys to production.

## Verify

Before every push:

```sh
npm ci
npm run check   # generated types are current, TypeScript
npm run lint    # oxlint, Prettier and knip; npm run format fixes the formatting
npm test        # Vitest inside the Workers runtime, with a local D1
```
