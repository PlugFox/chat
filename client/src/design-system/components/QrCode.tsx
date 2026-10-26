/**
 * A QR code drawn as one SVG path, dark on light in every theme (cameras
 * read inverted codes poorly), with the quiet zone the format requires. The
 * encoder is loaded only when a code is shown. `label` names the image; the
 * caller says next to it what to do with the code.
 */
import { createResource, type JSX, Show } from "solid-js";
import styles from "./QrCode.module.css";

/** Modules of light margin on every side (the QR specification asks for four). */
const QUIET = 4;

async function modules(value: string): Promise<{ size: number; path: string }> {
  const { encode } = await import("uqr");
  // Medium error correction: a phone screen photographed at an angle loses a little.
  const qr = encode(value, { ecc: "M", border: 0 });
  let path = "";
  qr.data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    });
  });
  return { size: qr.size + QUIET * 2, path };
}

export function QrCode(props: { value: string; label: string }): JSX.Element {
  const [code] = createResource(() => props.value, modules);
  return (
    <div class={styles["frame"]}>
      <Show when={code.latest}>
        {(c) => (
          <svg
            class={styles["code"]}
            viewBox={`0 0 ${c().size} ${c().size}`}
            role="img"
            aria-label={props.label}
            shape-rendering="crispEdges"
          >
            <rect class={styles["ground"]} width={c().size} height={c().size} />
            <path class={styles["modules"]} d={c().path} />
          </svg>
        )}
      </Show>
    </div>
  );
}
