# Design system

Every pixel of the client comes from `client/src/design-system/`. Screens
compose components; components read tokens; tokens are DTCG JSON.

## Layers

| Layer | Where | Emitted as CSS? | Used by |
| ----- | ----- | --------------- | ------- |
| Primitives | `tokens/primitives.json` | No | Only `base.json` and themes, through `{references}` |
| Base (theme-independent) | `tokens/base.json` | `:root`, `--<path>` | Components |
| Theme | `tokens/themes/<name>.json` | per theme selector | Components |
| Component-local | inside a component's CSS module | `--_name` | That component only |

Primitives are never emitted, so a component cannot reach `#4f46e5`: it says
what the color _means_ (`--color-accent-default`). Token path → variable:
`color.bg.default` → `--color-bg-default`. The Vite plugin
(`vite-plugin.ts`) writes `generated/tokens.css` (gitignored) on every dev
start and build, and again when a token file changes.

## Themes

`light` (default) and `dark`; high contrast and AMOLED later. A theme lists
the same semantic tokens as `light`, directly or by `extends`; the generator
fails otherwise.

- No saved choice: no `data-theme` on `<html>`, CSS follows
  `prefers-color-scheme`.
- Explicit choice (Settings): `localStorage.theme`, applied as `data-theme`
  by `public/theme.js` before first paint. It is a file, not an inline script,
  because the CSP allows scripts from `'self'` only.

Adding a theme: `tokens/themes/<name>.json`, the name in `themes.ts` and in
`public/theme.js`, a label in Settings (and strings). The tests then cover it.

## The contract

Enforced by Stylelint (`client/stylelint.config.mjs`) and
`client/tests/unit/design-system-contract.test.ts`:

- Colors, spacing, font properties, border widths, radii, shadows, z-index
  and durations use tokens. No raw colors anywhere (hex, named, system colors,
  color functions), no `px` or other absolute units (the visually-hidden 1px
  is the documented exception), no `!important` (except reduced motion).
- Logical properties only (`margin-inline`, `inset-block-start`…), so RTL
  works without overrides; `margin`/`padding`/`inset` take one value.
- CSS lives only in `design-system/` (CSS modules next to components, plus
  `styles/global.css` for the reset). Features, the app and the UI kit set no
  `class` or `style`: a missing look becomes a component or a variant.
- Variants are `data-*` attributes on the component root. Components declare
  only local `--_*` properties.
- Every interactive element is at least 48×48 (`--size-target-min`);
  `tests/e2e/touch-targets.spec.ts` measures every focusable element on every
  page, on phone and desktop, with the drawer open.

## Components

| Component | Notes |
| --------- | ----- |
| Button | `primary` / `secondary` / `danger` / `ghost`; `md` 48px, `lg` 56px; optional leading icon |
| IconButton, IconLink | 48×48, `label` required (accessible name and tooltip); `IconLink` is the same look as a router link; a toggle says its state with `aria-pressed` and shows it filled |
| Icon | Material Symbols Outlined 400 as inline SVG paths; decorative unless `label`; `mirrorInRtl` |
| Heading, Text | `level` (outline) and `size` (look) are independent; `tone="muted"`, `measure` |
| Stack | flex layout with token gaps; use it instead of custom layout CSS |
| TextField, Select | visible label, hint and error tied by `aria-describedby`; suggestions are a row of buttons under the input, not a listbox popup (same for touch, keyboard and screen readers; the focus stays in the input); native `<select>` |
| Checkbox | native input, transparent and covering the whole row (the target), with a drawn box; hint by `aria-describedby` |
| QrCode | one SVG path, dark on light in every theme (`--color-qr-*`: cameras read inverted codes poorly), 4-module quiet zone; `uqr` is loaded only when a code is shown (10 KB chunk) |
| RecoveryWords | the recovery key as a numbered `ol`, monospace, two columns on phones and three from 40rem |
| Banner | `info`/`success`/`warning` as `role="status"`, `danger` as `role="alert"` |
| Dialog | native `<dialog>` (focus trap, Esc, top layer); title focused on open |
| Section | a titled card; `flat` drops the card in narrow panes |
| AppShell, NavLink, Page, EmptyState | the app frame: sidebar from 52.5rem, drawer below |
| EntryShell | the frame before sign-in: brand and one centered column in `main`, no navigation (seen on `/sign-in`) |
| List, ListItem | rows with a title, an optional badge, muted details and end-aligned actions that wrap on phones (sessions, sign-in methods, activity) |
| ChatLayout, Pane | a list and its open item (chats, notes) side by side from 75rem, one at a time below, with a visually hidden `h1` while the item shows alone; a pane's header (back button only where one pane shows; a first pane's `h1` takes the focus after navigation, as a page's does), body that scrolls or is filled, pinned footer (seen on `/`) |
| ChatRow, ChatRows | a chat in the list: link, muted detail, busy dot, actions; `ChatRows` with `reorder` adds a handle that moves a row by pointer or arrow keys |
| Message, MessageList | a message (the user's at the end of the line, text with its line breaks, status, meta, actions, placeholder; a summary is a card whose text folds under its label; a saved mark; an outline on the message a link opened the chat at); the list is virtualized with virtua and follows the end while the user is there, or opens centered on a `target` and holds it there while rows load until the user moves the list |
| RichEditor | a note's document edited in place (ProseMirror, loaded with the first editor): a toolbar of toggles that stays in view and wraps from 52.5rem (scrolls sideways below), Markdown shortcuts, dialogs for links, callout kinds and table rows and columns; task boxes drawn small inside 48px targets; charts and unknown blocks shown as in a message and moved whole; the focus shows on the toolbar's edge, not as a ring around the note; code wraps instead of scrolling (seen on `/ui-kit`) |
| RichText | a message document: headings from `h3`, ranked by the levels the document uses so the outline skips none, lists and tasks, quotes, callouts by kind, folding panels (`<details>`), code and tables that scroll inside themselves and take focus (not landmarks), a copy button per table; links only `http`, `https`, `mailto`, in a new tab, exempt from the 48px target as text in a sentence (`data-rich-text` tells the e2e check); a chart with a button that swaps it for its table |
| Chart | a chart drawn by Chart.js, loaded on first use: a canvas with `role="img"` and a name, colors from `--color-chart-1…8` read again when the theme changes, no animation; its data is offered as a table by the caller |
| Composer | growing text area and one button that sends or stops; Enter sends, Shift+Enter is a new line; optional options button under it that names the chat's settings in short and opens them |
| TextArea | a labelled multi-line input, for longer text than `TextField` |
| Toaster | notices at the bottom, `status` or `alert` by tone, dismissible; the app's `useToasts()` shows them |
| SkipLink, VisuallyHidden | accessibility helpers |

New component checklist: the `add-component` skill. Icons:
`bun scripts/add-icon.ts <name>` (from `client/`).

## UI kit

`/ui-kit` shows every component and variant. It exists in development and
test builds (`bun run build:test`) and is left out of production builds;
the e2e suite runs axe and the touch-target check on it in every theme.

## Contrast

`tests/unit/tokens.test.ts` checks, in every theme, the text/background pairs
components use (4.5:1) and control boundaries and focus rings (3:1). The pairs
are a hand-kept list: when a component puts one token on another, add the pair.

## Breakpoints

Custom properties do not work in media queries, so breakpoints are a
convention, in `rem` with range syntax: compact `(width < 37.5rem)`, medium
`(width >= 37.5rem)`, expanded `(width >= 52.5rem)` (the sidebar appears),
large `(width >= 75rem)`. Prefer intrinsic layouts.
