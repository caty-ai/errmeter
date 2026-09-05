# errmeter

Error meter reading for AI agent families.

Every agent gets one command. When something breaks, it writes one line locally
(emit → spool). A separate, replaceable adapter forwards it (sink). A watcher
on any always-on machine picks it up and starts the fix (watch).

- Zero dependencies. Node 18+. No TypeScript build step.
- No GitHub Actions or paid CI required. GitHub is used only as a bulletin board (Issues API, free).
- Works on macOS / Linux / Windows. OS-specific boot registration is hidden behind `errmeter install`.

Status: design phase. See [docs/design-brief-v0.md](docs/design-brief-v0.md) and the EPIC issue.

Private until the publication gate passes. Will be published under caty-ai and on npm as `errmeter`.

License: MIT
