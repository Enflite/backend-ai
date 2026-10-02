# Enflite Frontend Design System

Living contract for the UI redesign (Jake's "Professional Frontend UI/UX
Redesign" brief). Every surface — Chat, Board, Form AI, SyteLine, Knowledge,
and upcoming agent views (APS Planning Agent) — builds from this.

## Themes (`frontend/src/index.css`)

**Dark-first.** Dark is the default theme; light is available as an explicit
choice. Never key anything off `prefers-color-scheme` — the user's choice is
the only signal.

- Tokens are CSS custom properties on `:root` (light values).
- `[data-theme="dark"]` overrides every token with dark values.
- A tiny inline script in `frontend/index.html` reads `localStorage`
  key `enflite-theme` (`'dark' | 'light'`) and sets
  `document.documentElement.dataset.theme` **before first paint**, so there
  is no light-to-dark flash. Unknown or missing values fall back to dark.
- `frontend/src/hooks/useTheme.ts` owns runtime behavior: `useTheme()`
  returns `[theme, toggleTheme]`, applies `data-theme` to `<html>`, and
  persists every change. Pure helpers (`parseTheme`, `toggleThemeName`) are
  unit-tested without a DOM.
- The theme toggle is a sun/moon `IconButton` in the shell nav footer
  (`shell/AppShell.tsx`), next to sign out. It shows the icon of the theme
  you will switch *to* (sun when dark, moon when light), with an accessible
  label (`aria-pressed`).
- Dark also sets `color-scheme: dark` for native form controls/scrollbars,
  and re-tints the webkit scrollbar.

## Tokens (`frontend/src/index.css`)

Calm enterprise palette. Enflite Red `#CF0C2C` is the **single accent** —
use sparingly: active nav, primary actions, AI activity, security cues,
destructive actions. Never large red surfaces. On dark surfaces the accent
brightens to `#E11D48` so it keeps its weight.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `#FAFAFA` | `#0B0B0D` | App background |
| `--card` | `#FFFFFF` | `#141417` | Surfaces: nav rail, panels, dialogs, cards |
| `--secondary` / `--muted` | `#F5F5F5` | `#1C1C21` | Subtle fills: contextual panels, hovers, wells |
| `--border` | `#E7E7E7` | `#26262C` | Hairline borders/dividers |
| `--foreground` | `#18181B` | `#F4F4F5` | Primary text |
| `--muted-foreground` | `#71717A` | `#A1A1AA` | Secondary text |
| `--accent` | `#CF0C2C` | `#E11D48` | Enflite red accent |
| `--ring` | `#CF0C2C` | `#E11D48` | Focus ring |
| `--danger` | `#A50A24` | `#F87171` | Error text/icons; replaces hardcoded `#a50a24` |
| `--danger-bg` | `#FEE2E2` | translucent `#F87171` | Error surface wash |
| `--radius` / `--radius-lg` / `--radius-xl` | `6px` / `10px` / `14px` | unchanged | Corners |
| `--shadow-xs` / `--sm` / `--md` / `--lg` | — | darker variants | Elevation (most surfaces stay flat on borders) |

Type scale: page title `20px/600` (`--text-page-title`), section title
`15px/600` (`--text-section-title`), body `14px` (`--text-body`), secondary
`13px` (`--text-secondary`), metadata `12px` (`--text-meta`). AI long-form
content: `.prose-measure` (max-width 46rem, line-height 1.65).

Classification colors (the app's real levels — never invent levels).
Dark variants are slightly brightened versions of the same hues:

| Level | Light | Dark | Color token |
|---|---|---|---|
| PUBLIC | `#15803D` | `#22C55E` | `--class-public` |
| INTERNAL | `#2563EB` | `#60A5FA` | `--class-internal` |
| CONFIDENTIAL | `#B45309` | `#F59E0B` | `--class-confidential` |
| PROPRIETARY | `#CF0C2C` | `#E11D48` | `--class-proprietary` |
| CUI | `#7E22CE` | `#A855F7` | `--class-cui` |
| UNKNOWN | `#6B7280` | `#9CA3AF` | `--class-unknown` |

## Primitives (`frontend/src/components/ui/primitives.tsx`)

Use these; do not invent one-off buttons/inputs/badges elsewhere:

- `Button` — variants `primary | secondary | outline | ghost | danger`, sizes `sm | md`
- `IconButton` — ghost icon button, takes `label` (accessible name)
- `Badge` — tones `neutral | red | green | blue | amber | purple | gray`
- `ClassificationBadge` — the shared security pill; `CLASSIFICATION_DESCRIPTIONS` for menus
- `Card`, `PageHeader` (title + description + actions), `SectionLabel`
- `TextInput`, `Select`, `Modal` (Escape-to-close, overlay click, focus management, `.animate-scale-in` entrance)
- `Skeleton` (shimmer block; `aria-hidden`; `width`/`height` props), `Kbd` (keyboard-hint chip), `LiveDot` (pulsing dot + text label, e.g. "live")

Existing `ui/` pieces still in use: `ErrorState` (+ `DisabledState`,
`NotAuthorizedState`), `StatusBadge`, `Spinner`.

## Motion (`frontend/src/index.css`)

Small, fast, ease-out. Every entrance/state animation lives in the
160–240ms band (exception: ambient indicators like the pulse dot are
infinite). Compose these utilities — never invent one-off keyframes in
views. Existing avatar/activity animations are unchanged.

| Utility | Motion | Duration |
|---|---|---|
| `.animate-fade-up` | 12px rise + fade | 200ms |
| `.animate-fade-in` | fade | 180ms |
| `.animate-slide-in-right` | slide 24px from right + fade | 220ms |
| `.animate-scale-in` | scale 0.96→1 + fade | 160ms |
| `.animate-pulse-dot` | pulse (infinite) | 1.6s |
| `.skeleton-shimmer` | loading wash sweep (infinite) | 1.4s |

`prefers-reduced-motion: reduce` kills all of the above (animation: none),
alongside the existing avatar/activity/panel/message animations.

## Navigation model (`frontend/src/shell/AppShell.tsx`)

One global nav rail: Chat, **Agents**, Board, Form AI Agent, SyteLine.
`NAV_ITEMS` supports an optional `section`; sections render only when they
contain items.

- The top-level **Agents** entry (`/agents/*`, `views/AgentsView.tsx`) is the
  agents product area — its index is a directory of the agent surfaces
  registered in `AGENT_SURFACES` (each a live destination with honest
  permission-gated status). Agent teams own their views and sub-routes
  under `/agents/*` (task-agent landing, task detail, approvals, …).
- **Agent extension slot:** specialized AI agents register as
  `{ to, label, section: 'Agents', permissions, icon }`. Example:

```tsx
{ to: '/aps', label: 'APS Planning Agent', section: 'Agents',
  permissions: ['aps:plan'], icon: (a) => <IconAps active={a} /> },
```

Views needing contextual navigation (Chat's conversation list) render it as
a **secondary panel inside the view**: subtle `--secondary` background,
`SectionLabel` header, no brand mark. Never a second white nav rail.

## Command palette (`frontend/src/components/CommandPalette.tsx`)

Global ⌘K (Ctrl+K) palette, mounted in `AppShell`. Grouped results, in
order: **Go to** (destinations from the shared `shell/navRegistry.tsx`
plus permission-gated deep links: New task, Workflows, Today board),
**Actions** (New agent task, New chat, Toggle theme, Go to board Today
view), **Tasks**, **Conversations**, **Forms**. Permission-aware: locked
destinations are omitted, never shown as available.

- Data lazy-loads on **first open only** (never on app mount), cached per
  session; groups load independently — a failed group shows a retry, never
  a raw error. Lists are capped (8 per group), "recent" ordered by
  `updatedAt`.
- Search is a dependency-free fuzzy subsequence match
  (`components/fuzzy.ts`), ranked **prefix > word-boundary >
  subsequence**, across title + keywords.
- Styling: centered overlay in the top third, Card-like surface,
  `.animate-scale-in`, theme tokens. `role="dialog"` + `aria-modal`,
  `listbox`/`option` roles with `aria-activedescendant`, footer shows
  `Kbd` hints.

## Keyboard conventions

- `⌘K` / `Ctrl+K` — open/close the command palette (global).
- `↑`/`↓` (or `Ctrl+N`/`Ctrl+P`) — move through palette results;
  `Enter`/`↵` — open the highlighted result; `Esc` — close the palette
  (and other `Modal` dialogs).
- New keyboard-driven surfaces follow the palette pattern: focus the
  input on open, return focus to the trigger on close, keep hints in a
  `Kbd` footer, respect `prefers-reduced-motion` via the shared motion
  utilities.

## Layout rules

- Chat: top bar → conversation → composer. Assistant responses are editorial
  documents (no chat bubbles); user messages stay differentiated.
- Cards are for operational objects (documents, tasks, credentials, security
  state) — never wrap every AI paragraph in a card.
- Debug internals (session IDs, token counts, raw similarity scores, raw
  backend state) go under Details/Diagnostics, never in primary flows.
- Activity feed shows only what the backend actually reported — never
  fabricate tool activity.
- No fake data, no placeholder pages, no dead nav items. Empty states explain
  how to get started.
- Security/classification/permission concepts are never removed or hidden;
  classification is a visible security control, not a technical dropdown.
- Responsive: sidebars become drawers on small screens; never shrink fixed
  layouts. Reduced-motion preferences are respected.
- Keyboard: visible focus, Escape closes dialogs/panels, icon buttons have
  accessible names, don't rely on color alone for state.
