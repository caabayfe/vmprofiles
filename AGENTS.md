# AGENTS.md — conventions for AI coding assistants

This file is read by Cursor, Claude Code, Aider, Continue, GitHub Copilot
Chat, and similar tools when a session starts in this repo. Keep it short.

## Frontend (static-web-app components)

- **Read `docs/guides/frontend.md` first** (via `yarp_guide_get("frontend")`).
  It covers the portal chrome contract — side menu, breadcrumbs, user
  context — and the client-side routing pattern every Function is expected
  to use.
- Drive the left rail through the standard side menu
  (`window.INSIGHT_MENU.sidemenu.set(...)`). Don't build a custom
  nav component. See §7 "Function menu (Side menu)" for the API and
  the `onClick` override needed when your router is client-side.

## Routing — critical constraints

- **Do NOT add a `<BrowserRouter>`** — `ServicesPortalProvider` already
  provides one internally. Pass `routerProps={{ basename }}` to configure it.
- **`react-router-dom` must be `^6`** — the DSP library bundles v6 internally.
  Installing v7+ causes two router instances and silent context errors
  (caught by ErrorBoundary as "something went wrong").
- The template already pins `react-router-dom: ^6.22.0` in package.json.
  Do NOT upgrade it to v7.

## UI Components — mandatory DSP library usage

- **Always** use `@nttdsp/react-components` for all UI controls.
  Never use raw HTML `<input>`, `<select>`, `<textarea>`, or `<button>`
  where a DSP component exists. Raw elements break in dark mode and
  fail design compliance.
- Key mappings: `Input` (not `<input>`), `Select` (not `<select>`),
  `TextArea` (not `<textarea>`), `Button` (not `<button>`),
  `Checkbox`, `RadioGroup`, `Modal`, `DatetimePicker`, `Spinner`.
- Import `flatpickr/dist/flatpickr.min.css` when using `DatetimePicker`.
- Check the Storybook for available components before building custom UI:
  `https://intiop.portal.nttltd.global.ntt/l/static/react-components/`
- Full rules: `yarp_guide_get("react")` §10 (Forms and validation).

## Translations (static-web-app components)

- Every user-visible string passes through `T.<KEY>` or
  `dynamicTranslation()` from `@nttdsp/react-components`.
  No literal English in JSX outside test fixtures.
- Locale comes from the portal hint via `useTranslation()`. Do NOT
  add an in-app picker, store a locale in localStorage, or route on a
  `/:lang/...` URL prefix. One source of truth.
- Declare which locales this app ships translations for in
  `yarp.json`'s `languages` field. Add new keys to
  `src/translations.ts` (app-wide) or a sibling
  `translations.ts` (feature-scoped, merged via
  `setTranslations(...)`).

## Database lifecycle is separate from release

`yarp release` ships container images + static blobs. It does NOT
apply DB schema. By design — see ADR
`2026-05-05-pgschema-as-source-of-truth.md` — the schema lifecycle
is decoupled so a release can roll forward without dragging the DB
along, and a schema change can ship independent of code.

After every release that touched the schema (or on first deploy of
this app to a new env), run:

```sh
yarp db-migrate --component db --env <env>
```

<!-- yarp:platform:start — managed by `yarp agents-refresh`, do not edit -->
## YARP Platform (auto-managed)

This is a YARP app. The platform CLI `yarp` handles build, deploy,
and dev-loop workflows.

### Workflow (the only commands you need)

| Task | Command |
|---|---|
| Scaffold from template | `yarp template <name> <app> --space=<space> [--resource=<singular>]` |
| Provision dev infra | `yarp dev-init` (also registers the app) |
| Push code & make live | `yarp dev-push` (pushes all components; SPAs auto-build) |
| Apply DB migrations | `yarp db-migrate --component <name>` |
| Curl with auth | `yarp curl --component <name> /path` |
| Check status | `yarp status` |
| Tail logs | `yarp logs --component <name> --timeout 30` |
| Run compliance scan | `yarp codescan` |
| Build a versioned artifact | `yarp build` |
| Ship to an environment | `yarp release --env pre|prod` |

### IMPORTANT rules

- Do NOT use `files-sync`, `files-put`, `register`, or `dev-build` — use `dev-push` instead
- Do NOT run `npm install` or `git init` — YARP needs neither
- Use `yarp codescan` to scan for CVEs and compliance issues — do NOT use `yarp build` for scanning alone; `yarp build` cuts a versioned release artifact
- `yarp curl` paths are component-relative: `yarp curl --component api /health` NOT `/api/health`
- `yarp dev-init` registers the app automatically — no separate `yarp register` needed
- `yarp dev-push` without `--component` pushes ALL components — no need to run it per-component
- Use `--resource=dog` on `yarp template` to name the domain object (plural auto-derived: dog→dogs)
- This is a STARTING POINT, not a finished app: the demo `name`/`description` fields are placeholders — edit `db/schema.sql` and the Pydantic models in `api/main.py` directly to fit your domain (add `breed`, `age`, etc.). The platform won't generate fields from a flag; shaping the domain is your job (ADR 2026-06-17-templates-are-minimal-starting-points)
- Always pass `--timeout 30` to `yarp logs` — without it the command may hang waiting for output

### Dev workflow after dev-init

`yarp dev-init` provisions infra AND syncs your source code. After that:

- **Any component**: edit files → `yarp dev-push` → live (backends hot-reload ~2s; SPAs cloud-build ~10-60s)
- **Database**: edit schema.sql → `yarp dev-push --component db` → `yarp db-migrate --component db`

### Manifest

Single root `yarp.json` — app fields top-level + a typed `components`
list. `dev-init` syncs it automatically.

### Verification (without a browser)

The app runs behind portal auth — you cannot open it in a browser without
being logged in. For programmatic verification, use `yarp curl`:

```sh
# API health check
yarp curl --component api /health

# Verify CRUD
yarp curl --component api /dogs -X POST -d '{"name":"Rex","breed":"Lab","age":3}'
yarp curl --component api /dogs

# Verify frontend HTML is served
yarp curl --component webapp /
```

`yarp curl` handles all auth (bearer token + persona) automatically.
Do NOT use raw `curl` — it will 401/403 without the correct headers.

### Deeper guidance

For detailed platform guides (frontend, auth, translations, DB migrations,
React, Python, etc.) use the MCP tools: `yarp_guide_get("<slug>")`.
Run `yarp mcp-server --show-tools` to see available slugs.

### Refresh this section

Run `yarp agents-refresh` to update these platform rules to match
your installed CLI version. Content outside these markers is yours to edit.
<!-- yarp:platform:end -->
