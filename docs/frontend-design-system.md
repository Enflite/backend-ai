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
destructive actions. Never large red surfaces. The dark theme is the
Relay-adopted surface (see "Relay adoption" below); it no longer
brightens the accent — the brand red carries both themes.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--background` | `#FAFAFA` | `#0D0F0E` | App background |
| `--card` | `#FFFFFF` | `#111412` | Surfaces: nav rail, panels, dialogs, cards |
| `--panel-raised` | — (dark only) | `#161A17` | Raised panels above `--card` |
| `--secondary` / `--muted` | `#F5F5F5` | `#161A17` | Subtle fills: contextual panels, hovers, wells |
| `--border` | `#E7E7E7` | `rgba(224,236,222,0.09)` | Hairline borders/dividers |
| `--border-strong` | — (dark only) | `rgba(224,236,222,0.14)` | Emphasized hairlines |
| `--foreground` | `#18181B` | `#E8E9E3` | Primary text |
| `--muted-foreground` | `#71717A` | `#7D857F` | Secondary text |
| `--muted-bright` | — (dark only) | `#AAB1AC` | Tertiary text, one step up from muted |
| `--accent` | `#CF0C2C` | `#CF0C2C` | Enflite red accent |
| `--accent-soft` | — (dark only) | `rgba(207,12,44,0.10)` | Accent wash (active nav, pills) |
| `--ring` | `#CF0C2C` | `#CF0C2C` | Focus ring |
| `--danger` | `#A50A24` | `#F87171` | Error text/icons; replaces hardcoded `#a50a24` |
| `--danger-bg` | `#FEE2E2` | translucent `#F87171` | Error surface wash |
| `--radius` / `--radius-lg` / `--radius-xl` | `6px` / `10px` / `14px` | unchanged | Corners (`--radius-lg: 10px` matches Relay) |
| `--shadow-xs` / `--sm` / `--md` / `--lg` | — | darker variants | Elevation (most surfaces stay flat on borders) |

### Relay adoption (R1 — tokens & typography)

The dark theme is retuned toward the Relay reference design
(`workspace/reference/figma-relay/`): near-black green-tinted neutrals
(`#0D0F0E` background, `#111412` card, `#161A17` raised), translucent
green-white hairlines, Manrope/DM Mono type, 160ms-ease hover rhythm with
a 1px hover lift (`.hover-lift`), and a whisper of red in a radial top
glow (`radial-gradient(circle at 58% -20%, rgba(207,12,44,0.05),
transparent 31%)` layered over `--background`). The glow lives on the
`.app-shell-root` hook (AppShell's root div; its background moved from an
inline style into the stylesheet so the theme owns it) and on `body`,
so the signature is visible wherever the shell doesn't cover. Token names the
views already use (`--background`, `--card`, `--secondary`, `--muted`,
`--border`, `--foreground`, `--muted-foreground`, `--accent`, `--ring`,
`--danger`) keep working; the remap is value-only, plus the additive
`--panel-raised`, `--border-strong`, `--muted-bright`, `--accent-soft`
tokens.

**Accent swap rationale.** Relay's signature is its lime `#C8F76B`;
Enflite's signature is Enflite Red `#CF0C2C` (the documented brand
accent, from the light theme and the Enflite brand). R1 substitutes the
brand red wherever Relay uses lime — `--accent`, `--accent-soft`,
`--ring`, the top glow — used sparingly, never as large surfaces. The
red stays at brand weight on both themes so the accent reads the same in
light and dark. `--primary` keeps its brighter `#E11D48` dark variant for
button contrast, and the classification colors keep their brightened
dark hues (they are data colors, not the accent).

### Typography

Manrope (sans) + DM Mono (mono), loaded first in
`frontend/src/index.css` via Google Fonts `@import` (with graceful
fallbacks if the font fetch fails):

- `--font-sans: 'Manrope', 'Inter', system-ui, sans-serif` — body text.
  (Tailwind's `font-sans` utility and the `@theme` mapping follow this.)
- `--font-mono: 'DM Mono', 'JetBrains Mono', monospace` — code, `Kbd`
  chips, numeric/terminal readouts.

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

Small, fast, ease-out. The global `*` transition runs at **160ms ease**
(Relay's hover rhythm); every entrance/state animation lives in the
160–240ms band (exception: ambient indicators like the pulse dot are
infinite). Compose these utilities — never invent one-off keyframes in
views. Existing avatar/activity animations are unchanged.

| Utility | Motion | Duration |
|---|---|---|
| `.hover-lift` | 1px rise on hover (eased by the global transition) | 160ms |
| `.animate-fade-up` | 12px rise + fade | 200ms |
| `.animate-fade-in` | fade | 180ms |
| `.animate-slide-in-right` | slide 24px from right + fade | 220ms |
| `.animate-scale-in` | scale 0.96→1 + fade | 160ms |
| `.animate-pulse-dot` | pulse (infinite) | 1.6s |
| `.skeleton-shimmer` | loading wash sweep (infinite) | 1.4s |

`prefers-reduced-motion: reduce` kills all of the above (animation: none),
alongside the existing avatar/activity/panel/message animations.

## Navigation model (`frontend/src/shell/`)

### Shell anatomy: rail → contextual sidebar → main

The app shell is three columns, mirroring the Relay reference layout:

1. **Icon rail** (`shell/IconRail.tsx`) — the single global nav. 68px
   wide: the Enflite mark (32px `/enflite-logo.png`, links home) on top,
   one 38px icon button per destination, and theme toggle + identity
   avatar + sign out at the bottom. The search trigger (⌘K) lives here too.
2. **Contextual sidebar** (`shell/ContextSidebar.tsx`) — a 272px
   secondary panel rendered *inside the view that owns it* (Chat renders
   its conversation list there; R3/R5 add task/form/SyteLine panels).
   Slotted header + scrollable content + slotted footer, subtle
   `--secondary` background, `SectionLabel` header, no brand mark — so
   the app reads as one product instead of competing sidebars. Views
   without sidebars (`/agents/*`, `/board`, `/forms/*`, `/syteline/*`)
   simply don't render one.
3. **Main** — the routed view outlet (`<Outlet />`).

The nav registry (`shell/navRegistry.tsx`) is the single source of truth:
`NAV_ITEMS` with `{ to, label, icon, permissions?, section?, hideFromRail? }`.
The rail renders `railNavItems()` (everything not `hideFromRail`); the
palette renders all of `NAV_ITEMS`. Current rail order: **Home** `/`,
**Chat** `/chat`, **Tasks** `/agents/tasks`, **Board** `/board`,
**Form AI Agent** `/forms`, **SyteLine** `/syteline`.

- The **Agents** entry (`/agents`, `views/AgentsView.tsx`) takes no rail
  slot (`hideFromRail`) — the palette covers it — but stays discoverable
  as the index of the agent surfaces registered in `AGENT_SURFACES` (each
  a live destination with honest permission-gated status). Agent teams own
  their views and sub-routes under `/agents/*` (task-agent landing, task
  detail, approvals, …).
- **Agent extension slot:** specialized AI agents register as NavItems
  with `section: 'Agents'`. The section renders only when it has items, so
  no dead UI ships before an agent lands. Example:

```tsx
{ to: '/aps', label: 'APS Planning Agent', section: 'Agents',
  permissions: ['aps:plan'], icon: 'spark' },
```

**Permission-aware, never hidden dead-ends:** every destination always
renders so users can discover what exists. Items the signed-in user can't
reach render locked — dimmed, with a lock affordance and a tooltip naming
the missing permission (`Requires syteline:forms permission`). On the
rail that's `aria-disabled` + tooltip and no navigation; in the palette
locked destinations are omitted, never shown as available. The nav is a
convenience, not a security boundary — views still enforce access.

### Icon usage (`frontend/src/components/icons.tsx`)

One shared `Icon({ name, size })` component: 24×24 stroke icons in the
Relay stroke grammar (1.7px, round caps/joins), rewritten in our 24-grid.
Rail buttons, contextual sidebars, and palette "Go to" rows all render
through it — never hand-rolled SVGs per surface (the old `navRegistry`
inline icons were deleted in the shell v2 slice). Only add icons that are
actually used somewhere; `shell/shell.test.ts` pins that every registry
icon name exists in the set and that rail icons are distinct.

### Responsive rules (shell CSS lives in `index.css`)

| Breakpoint | Rail | Contextual sidebar |
|---|---|---|
| > 1050px | 68px | 272px |
| ≤ 1050px | 60px | 238px (the active rail edge recenters: `left: -11px`) |
| ≤ 720px | 68px (stays) | leaves the flow → **slide-over**: fixed, `min(300px, 84vw)`, off-canvas until opened; its own floating menu button (in normal flow, so it never overlaps view chrome) toggles it, a backdrop click closes it |

The slide-over's open state is owned by the view (Chat closes it on
select/new). `prefers-reduced-motion` disables the slide-over transition
alongside the rail hovers; keyboard focus stays visible throughout
(`:focus-visible` ring on rail buttons, rows, and the new-chat button).
Never shrink fixed layouts — sidebars become drawers, exactly as above.

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

### Agent result review (SyteLine Form AI Agent detail)

The pattern for presenting an agent run that ends in a human approval gate
(`/forms/:id`, `components/formAgent/CustomizationDetail.tsx`):

- **Review hero first:** the result state leads with the outcome
  ("Ready for review"), the result summary, the commit metadata (repository,
  pull request, flow name/version, requested by), and the approve actions as
  the prominent primary actions — the agent never merges; the human merges
  on GitHub and records it.
- **Changes rendered from the real plan:** file-by-file rows (fields added
  with name/caption/kind, relabels, resizes, deck artifact) from the
  backend's validated `plan` — never fabricated; empty categories are
  omitted, not shown as zeros. The actual diff lives on the review PR:
  a "View full diff on GitHub" action links to `{prUrl}/files`.
- **Honest pending states:** while the pipeline is still running, actions
  whose target doesn't exist yet render as disabled buttons with a title
  explaining what is pending — never dead links.
- Sections use `Card` + `SectionLabel` + `Badge` for counts,
  `.animate-fade-up` for entrance, `aria-labelledby` headings, and list
  markup for change rows.
