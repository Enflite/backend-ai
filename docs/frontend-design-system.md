# Enflite Frontend Design System

Living contract for the UI redesign (Jake's "Professional Frontend UI/UX
Redesign" brief). Every surface — Chat, Board, Form AI, SyteLine, Knowledge,
and upcoming agent views (APS Planning Agent) — builds from this.

## Tokens (`frontend/src/index.css`)

Calm enterprise palette. Enflite Red `#CF0C2C` is the **single accent** —
use sparingly: active nav, primary actions, AI activity, security cues,
destructive actions. Never large red surfaces.

| Token | Value | Use |
|---|---|---|
| `--background` | `#FAFAFA` | App background |
| `--card` | `#FFFFFF` | Surfaces: nav rail, panels, dialogs, cards |
| `--secondary` / `--muted` | `#F5F5F5` | Subtle fills: contextual panels, hovers, wells |
| `--border` | `#E7E7E7` | Hairline borders/dividers |
| `--foreground` | `#18181B` | Primary text |
| `--muted-foreground` | `#71717A` | Secondary text |
| `--accent` | `#CF0C2C` | Enflite red accent |
| `--radius` / `--radius-lg` / `--radius-xl` | `6px` / `10px` / `14px` | Corners |
| `--shadow-xs` / `--sm` / `--md` / `--lg` | — | Elevation (most surfaces stay flat on borders) |

Type scale: page title `20px/600` (`--text-page-title`), section title
`15px/600` (`--text-section-title`), body `14px` (`--text-body`), secondary
`13px` (`--text-secondary`), metadata `12px` (`--text-meta`). AI long-form
content: `.prose-measure` (max-width 46rem, line-height 1.65).

Classification colors (the app's real levels — never invent levels):

| Level | Color token |
|---|---|
| PUBLIC | `--class-public` `#15803D` |
| INTERNAL | `--class-internal` `#2563EB` |
| CONFIDENTIAL | `--class-confidential` `#B45309` |
| PROPRIETARY | `--class-proprietary` `#CF0C2C` |
| CUI | `--class-cui` `#7E22CE` |
| UNKNOWN | `--class-unknown` `#6B7280` |

## Primitives (`frontend/src/components/ui/primitives.tsx`)

Use these; do not invent one-off buttons/inputs/badges elsewhere:

- `Button` — variants `primary | secondary | outline | ghost | danger`, sizes `sm | md`
- `IconButton` — ghost icon button, takes `label` (accessible name)
- `Badge` — tones `neutral | red | green | blue | amber | purple | gray`
- `ClassificationBadge` — the shared security pill; `CLASSIFICATION_DESCRIPTIONS` for menus
- `Card`, `PageHeader` (title + description + actions), `SectionLabel`
- `TextInput`, `Select`, `Modal` (Escape-to-close, overlay click, focus management)

Existing `ui/` pieces still in use: `ErrorState` (+ `DisabledState`,
`NotAuthorizedState`), `StatusBadge`, `Spinner`.

## Navigation model (`frontend/src/shell/AppShell.tsx`)

One global nav rail. `NAV_ITEMS` supports an optional `section`; sections
render only when they contain items.

**Agent extension slot:** specialized AI agents register as
`{ to, label, section: 'Agents', permissions, icon }`. Example:

```tsx
{ to: '/aps', label: 'APS Planning Agent', section: 'Agents',
  permissions: ['aps:plan'], icon: (a) => <IconAps active={a} /> },
```

Views needing contextual navigation (Chat's conversation list) render it as
a **secondary panel inside the view**: subtle `--secondary` background,
`SectionLabel` header, no brand mark. Never a second white nav rail.

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
