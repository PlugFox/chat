---
name: add-component
description: Create or extend a design-system component in Vault Chat (client/src/design-system/components) — a new UI element, a new variant or size. Use whenever a screen needs a look that no existing component provides.
---

# Add a design-system component

Read `docs/design-system.md` first. Screens never style themselves; a missing
look becomes a component or a variant.

## Steps

1. **Check what exists**: `ls client/src/design-system/components` and `/ui-kit`.
   Prefer a variant of an existing component.
2. **Tokens**: reuse semantic tokens. A new color is a primitive plus a
   semantic token in every theme; add its text/background pair to
   `tests/unit/tokens.test.ts`.
3. **Write** `<Name>.tsx` + `<Name>.module.css`:
   - doc comment: what it is, accessibility notes;
   - semantic element first (`<button>`, `<dialog>`, `<select>`…), ARIA only
     for what HTML cannot say; every string comes in as a prop (callers pass `t()`);
   - variants as `data-*` on the root; local custom properties `--_name`;
   - interactive parts ≥ 48×48 (`--size-target-min`), visible focus (global
     ring), hover/pressed state layer with `color-mix(in srgb, currentcolor var(--state-hover), transparent)`;
   - icons along the reading direction get `mirrorInRtl`.
4. **Export** it from `components/index.ts`.
5. **Showcase** every variant on `client/src/ui-kit/UiKit.tsx` (strings in both locales).
6. **Verify** (`verify-changes`): `mise run check:client`, `mise run check:e2e`,
   then look at `/ui-kit` on a phone and a desktop, light and dark.
7. **Docs**: a row in the components table of `docs/design-system.md`.

## Don'ts

- No global CSS; `styles/global.css` is the reset only.
- No styling another component's internals by its classes.
- No JS for what `<dialog>`, `<details>`, `popover` or `<select>` already do.
