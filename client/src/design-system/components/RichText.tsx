/**
 * A message document (docs/crypto.md, "Message documents") as HTML built
 * from its blocks, never from markup: text is text, and a link keeps only
 * an `http`, `https` or `mailto` address (checked again here, the server
 * writes these). Headings start at `h3`, under the page's and the chat's, and
 * take the levels the document uses in order, so the outline skips none.
 * Code and tables scroll inside themselves and take focus, so a keyboard
 * can scroll them; they are not landmarks, which a long reply would flood; a table has a button that hands it to
 * `onCopyTable`. Links open in a new tab and show their address as a tooltip;
 * they are text in a sentence, exempt from the 48px target (WCAG 2.5.8,
 * "inline"), which `data-rich-text` tells the e2e check.
 */
import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Block, CalloutKind, Span } from "../../protocol/generated/protocol";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import styles from "./RichText.module.css";

export interface RichTextLabels {
  /** The name each callout kind shows. */
  callout: Record<CalloutKind, string>;
  copyTable: string;
  taskDone: string;
  taskOpen: string;
}

export interface RichTextProps {
  blocks: Block[];
  labels: RichTextLabels;
  onCopyTable?: ((table: { head: Span[][]; rows: Span[][][] }) => void) | undefined;
}

const CALLOUT_ICONS: Record<CalloutKind, string> = {
  note: "info",
  tip: "lightbulb",
  important: "feedback",
  warning: "warning",
  caution: "report",
};

const SAFE_HREF = /^(https?|mailto):/i;

/** The heading levels a document uses, in order: a level's rank sets its element. */
function headingLevels(blocks: Block[], into = new Set<number>()): number[] {
  for (const b of blocks) {
    if (b.t === "h") into.add(b.level);
    else if (b.t === "list") for (const item of b.items) headingLevels(item.b, into);
    else if (b.t === "quote" || b.t === "callout" || b.t === "panel") headingLevels(b.b, into);
  }
  return [...into].sort((a, z) => a - z);
}

interface Context extends RichTextProps {
  /** A document level's rank among the levels it uses. */
  rank: (level: number) => number;
}

export function RichText(props: RichTextProps): JSX.Element {
  const levels = createMemo(() => headingLevels(props.blocks));
  return (
    <div class={styles["rich"]} data-rich-text>
      <Blocks
        blocks={props.blocks}
        labels={props.labels}
        onCopyTable={props.onCopyTable}
        rank={(level) => levels().indexOf(level)}
      />
    </div>
  );
}

function Blocks(props: Context): JSX.Element {
  return <For each={props.blocks}>{(block) => <BlockView block={block} {...props} />}</For>;
}

function BlockView(props: Context & { block: Block }): JSX.Element {
  const nested = (blocks: Block[]) => (
    <Blocks blocks={blocks} labels={props.labels} onCopyTable={props.onCopyTable} rank={props.rank} />
  );
  const b = props.block;
  switch (b.t) {
    case "p":
      return (
        <p class={styles["p"]}>
          <Spans spans={b.s} />
        </p>
      );
    case "h":
      return (
        <Dynamic component={`h${Math.min(6, 3 + props.rank(b.level))}`} class={styles["h"]} data-level={b.level}>
          <Spans spans={b.s} />
        </Dynamic>
      );
    case "list":
      return (
        <Dynamic component={b.start === undefined ? "ul" : "ol"} class={styles["list"]} start={b.start}>
          <For each={b.items}>
            {(item) => (
              <li class={styles["item"]} data-task={item.checked === undefined ? undefined : ""}>
                <Show when={item.checked !== undefined}>
                  <span class={styles["task"]}>
                    <Icon
                      name={item.checked ? "check_box" : "check_box_outline_blank"}
                      size="sm"
                      label={item.checked ? props.labels.taskDone : props.labels.taskOpen}
                    />
                  </span>
                </Show>
                <div class={styles["item-body"]}>{nested(item.b)}</div>
              </li>
            )}
          </For>
        </Dynamic>
      );
    case "quote":
      return <blockquote class={styles["quote"]}>{nested(b.b)}</blockquote>;
    case "callout":
      return (
        <div class={styles["callout"]} data-kind={b.kind} role="note">
          <p class={styles["callout-label"]}>
            <Icon name={CALLOUT_ICONS[b.kind]} size="sm" />
            {props.labels.callout[b.kind]}
          </p>
          {nested(b.b)}
        </div>
      );
    case "panel":
      return (
        <details class={styles["panel"]}>
          <summary class={styles["panel-title"]}>
            <Spans spans={b.title} />
            <span class={styles["marker"]}>
              <Icon name="arrow_drop_down" size="sm" />
            </span>
          </summary>
          <div class={styles["panel-body"]}>{nested(b.b)}</div>
        </details>
      );
    case "code":
      return (
        <pre class={styles["code"]} tabindex={0}>
          <code>{b.text}</code>
        </pre>
      );
    case "table":
      return (
        <div class={styles["table"]}>
          <div class={styles["table-scroll"]} tabindex={0}>
            <table>
              <thead>
                <tr>
                  <For each={b.head}>
                    {(cell, i) => (
                      <th scope="col" data-align={b.align[i()] || undefined}>
                        <Spans spans={cell} />
                      </th>
                    )}
                  </For>
                </tr>
              </thead>
              <tbody>
                <For each={b.rows}>
                  {(row) => (
                    <tr>
                      <For each={row}>
                        {(cell, i) => (
                          <td data-align={b.align[i()] || undefined}>
                            <Spans spans={cell} />
                          </td>
                        )}
                      </For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={props.onCopyTable}>
            {(copy) => (
              <IconButton
                icon="content_copy"
                label={props.labels.copyTable}
                onClick={() => copy()({ head: b.head, rows: b.rows })}
              />
            )}
          </Show>
        </div>
      );
    case "rule":
      return <hr class={styles["rule"]} />;
  }
}

function Spans(props: { spans: Span[] }): JSX.Element {
  return <For each={props.spans}>{(span) => <SpanView span={span} />}</For>;
}

function SpanView(props: { span: Span }): JSX.Element {
  const s = props.span;
  if (typeof s === "string") return <>{s}</>;
  const f = s.f ?? 0;
  let node: JSX.Element = s.text;
  if (f & 8) node = <code class={styles["inline-code"]}>{node}</code>;
  if (f & 4) node = <s>{node}</s>;
  if (f & 2) node = <em>{node}</em>;
  if (f & 1) node = <strong>{node}</strong>;
  const href = s.href;
  return (
    <Switch fallback={node}>
      <Match when={href && SAFE_HREF.test(href) && href}>
        {(url) => (
          <a class={styles["link"]} href={url()} title={url()} target="_blank" rel="noopener noreferrer">
            {node}
          </a>
        )}
      </Match>
    </Switch>
  );
}
