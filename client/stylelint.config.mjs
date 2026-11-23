/**
 * Stylelint enforces the design-system contract (docs/design-system.md, once written):
 * colors, spacing, typography, radii, shadows and z-indexes come from tokens;
 * physical directions are written as logical properties (RTL); no px or other
 * absolute units, no !important, no ids, no :global(); components declare only
 * local `--_*` custom properties.
 */

/** CSS system colors: they bypass the themes as surely as a hex value. */
const systemColors = [
  "AccentColor",
  "AccentColorText",
  "ActiveText",
  "ButtonBorder",
  "ButtonFace",
  "ButtonText",
  "Canvas",
  "CanvasText",
  "Field",
  "FieldText",
  "GrayText",
  "Highlight",
  "HighlightText",
  "LinkText",
  "Mark",
  "MarkText",
  "SelectedItem",
  "SelectedItemText",
  "VisitedText",
];

/**
 * A single value: one token without spaces, or one function call (two levels
 * of nesting, enough for `calc(var(--x) * 2)`). Two to four values in
 * `margin`, `padding` or `inset` are physical (top/right/bottom/left).
 */
const singleValue = ["/^[^\\s()]+$/", "/^[\\w-]+\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)$/"];

/** @type {import("stylelint").Config} */
export default {
  extends: ["stylelint-config-standard"],
  plugins: ["stylelint-use-logical", "stylelint-declaration-strict-value"],
  ignoreFiles: ["dist/**", "coverage/**", "src/design-system/generated/**"],
  rules: {
    "import-notation": "string",
    // Safari still ignores unprefixed `user-select`, and interactive components
    // set it so a click or double-click never selects their label.
    "property-no-vendor-prefix": [true, { ignoreProperties: ["-webkit-user-select"] }],
    "csstools/use-logical": ["always", { except: ["float"] }],
    "scale-unlimited/declaration-strict-value": [
      [
        "/color$/",
        "fill",
        "stroke",
        "background",
        "/^border(-(block|inline))?(-(start|end))?$/",
        "/^border(-[a-z]+)*-width$/",
        "outline",
        "outline-width",
        "outline-offset",
        "font",
        "font-family",
        "font-size",
        "font-weight",
        "line-height",
        "letter-spacing",
        "/^margin/",
        "/^padding/",
        "gap",
        "row-gap",
        "column-gap",
        "/radius$/",
        "box-shadow",
        "z-index",
        "transition-duration",
        "animation-duration",
      ],
      {
        // Shorthands are checked word by word: `solid` and `/` are structure, not values.
        ignoreValues: [
          "0",
          "auto",
          "inherit",
          "initial",
          "unset",
          "none",
          "transparent",
          "currentcolor",
          "normal",
          "solid",
          "/",
        ],
        expandShorthand: true,
        disableFix: true,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin fills in ${property} and ${value}
        message: 'Use a design token for "${property}" (docs/design-system.md), not "${value}"',
      },
    ],
    // Raw colors are banned in every property and inside every function
    // (color-mix(), gradients), not only in the color properties above.
    "color-no-hex": true,
    "color-named": "never",
    "function-disallowed-list": [
      "rgb",
      "rgba",
      "hsl",
      "hsla",
      "hwb",
      "lab",
      "lch",
      "oklab",
      "oklch",
      "color",
      "device-cmyk",
    ],
    "declaration-property-value-disallowed-list": [
      {
        // Properties whose values are author-chosen names (grid areas, anchors,
        // animations…) are skipped: `grid-area: field` is not a color.
        "/^(?!grid|anchor|position-anchor|container|animation|view-transition|counter|content|quotes|font-family|list-style)/":
          [`/(^|[^\\w"'-])(${systemColors.join("|")})($|[^\\w"'-])/i`],
      },
      { message: "Use a design token, not a system color (docs/design-system.md)" },
    ],
    "declaration-property-value-allowed-list": [
      { "/^(margin|padding|inset)$/": singleValue },
      { message: "Use margin-block/margin-inline (padding-*, inset-*) instead of a multi-value shorthand" },
    ],
    // Components may only declare local `--_*` properties: redeclaring a token
    // (`--color-bg-default`) would silently re-theme everything inside.
    // overflow-x/y are physical; `overflow` covers both axes.
    "property-disallowed-list": [
      ["/^--(?!_)/", "overflow-x", "overflow-y"],
      { message: "Declare only local --_* custom properties; use overflow, not overflow-x/y" },
    ],
    "unit-disallowed-list": ["px", "pt", "pc", "cm", "mm", "in", "Q", "q"],
    "declaration-no-important": true,
    "selector-max-id": 0,
    "selector-pseudo-class-disallowed-list": ["global"],
    "selector-class-pattern": ["^[a-z][a-z0-9]*(-[a-z0-9]+)*$", { message: "Use kebab-case class names" }],
    "custom-property-pattern": [
      "^_?[a-z0-9]+(-[a-z0-9]+)*$",
      { message: "Custom properties are tokens (--color-bg-default) or component-local (--_size)" },
    ],
  },
};
