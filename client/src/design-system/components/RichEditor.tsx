/**
 * The note editor (D-096): a document edited in place, with a toolbar of
 * formatting buttons above it that stays in view while the note scrolls.
 * ProseMirror loads with the first editor shown. Toggle buttons say their
 * state with `aria-pressed`; the editing area is a labelled multi-line
 * textbox. Links, callouts and tables are changed in dialogs. Charts and
 * blocks this client does not know show as they would in a message and
 * move or delete as a whole. A document the reader cannot show renders
 * `unreadable` instead, and nothing is edited.
 */
import type { EditorView } from "prosemirror-view";
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { render } from "solid-js/web";
import type { Block } from "../../protocol/generated/protocol";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { IconButton } from "./IconButton";
import styles from "./RichEditor.module.css";
import { RichText, type RichTextLabels } from "./RichText";
import { Stack } from "./Stack";
import { TextField } from "./TextField";

type Engine = typeof import("./editor-engine");
type Active = ReturnType<Engine["active"]>;
type Raw = Record<string, unknown>;
type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

let loading: Promise<Engine> | null = null;
function engine(): Promise<Engine> {
  loading ??= import("./editor-engine");
  return loading;
}

const CALLOUTS: CalloutKind[] = ["note", "tip", "important", "warning", "caution"];

export interface RichEditorLabels {
  area: string;
  placeholder: string;
  toolbar: string;
  heading: (level: 1 | 2 | 3) => string;
  bold: string;
  italic: string;
  strike: string;
  code: string;
  link: string;
  bulletList: string;
  orderedList: string;
  taskList: string;
  quote: string;
  callout: string;
  panel: string;
  codeBlock: string;
  table: string;
  rule: string;
  undo: string;
  redo: string;
  close: string;
  cancel: string;
  apply: string;
  remove: string;
  linkUrl: string;
  linkInvalid: string;
  calloutKinds: Record<CalloutKind, string>;
  addRow: string;
  addColumn: string;
  deleteRow: string;
  deleteColumn: string;
  deleteTable: string;
  rich: RichTextLabels;
}

export interface EditorContent {
  doc: { v: 1; blocks: Raw[] };
  /** The text, for an excerpt. */
  text: string;
}

export interface RichEditorProps {
  /** The document; a new value replaces what is shown (another note, or its newer version). */
  doc: unknown;
  readOnly?: boolean;
  labels: RichEditorLabels;
  locale: string;
  /** The user changed the document; `read` gives it, so a burst of changes is read once. */
  onChange: (read: () => EditorContent) => void;
  /** Markdown to blocks, for pasted plain text. */
  markdown?: (text: string) => Promise<Raw[] | null>;
  /** Shown in place of the editor for a document no reader would show. */
  unreadable: JSX.Element;
}

export function RichEditor(props: RichEditorProps): JSX.Element {
  let place: HTMLDivElement | undefined;
  let view: EditorView | undefined;
  let api: Engine | undefined;
  const [active, setActive] = createSignal<Active | null>(null);
  const [readable, setReadable] = createSignal(true);
  const [dialog, setDialog] = createSignal<"link" | "callout" | "table" | null>(null);
  const [url, setUrl] = createSignal("");
  const [urlError, setUrlError] = createSignal(false);

  const renderBlock = (block: Raw, dom: HTMLElement) => {
    const blocks = (block["t"] === "chart" ? [block] : []) as Block[];
    const fallback = typeof block["fallback"] === "string" ? block["fallback"] : "";
    return render(
      () => (
        <RichText
          blocks={blocks.length > 0 ? blocks : fallback ? [{ t: "p", s: [fallback] }] : []}
          labels={props.labels.rich}
          locale={props.locale}
        />
      ),
      dom,
    );
  };

  /** Runs the command `make` builds from the engine, which is loaded once a toolbar shows. */
  const cmd = (make: (e: Engine) => Parameters<Engine["run"]>[1]) => {
    if (view && api) api.run(view, make(api));
  };

  const openLink = () => {
    const state = view && api ? api.active(view.state) : null;
    setUrl(state?.marks.link ?? "");
    setUrlError(false);
    setDialog("link");
  };

  onMount(() => {
    void engine().then((e) => {
      if (!place) return;
      api = e;
      const doc = e.toEditor(props.doc);
      setReadable(doc !== null);
      if (!doc) return;
      view = e.createEditor(place, {
        doc,
        editable: () => !props.readOnly,
        label: props.labels.area,
        placeholder: props.labels.placeholder,
        taskLabel: (done) => (done ? props.labels.rich.taskDone : props.labels.rich.taskOpen),
        onLink: openLink,
        renderBlock,
        ...(props.markdown ? { markdown: props.markdown } : {}),
        onUpdate: (state, changed) => {
          setActive(e.active(state));
          if (changed) {
            props.onChange(() => {
              const current = view?.state.doc ?? state.doc;
              return { doc: e.fromEditor(current), text: e.plainText(current) };
            });
          }
        },
      });
      setActive(e.active(view.state));
    });
  });

  createEffect(
    on(
      () => props.doc,
      (doc) => {
        if (!api || !view) return;
        const next = api.toEditor(doc);
        setReadable(next !== null);
        if (next) api.replaceDoc(view, next);
        setActive(api.active(view.state));
      },
      { defer: true },
    ),
  );

  createEffect(
    on(
      () => props.readOnly,
      () => view?.setProps({}),
      { defer: true },
    ),
  );

  onCleanup(() => view?.destroy());

  const toggle = (label: string, icon: string, pressed: () => boolean | undefined, command: () => void) => (
    <IconButton icon={icon} label={label} aria-pressed={pressed() ? "true" : "false"} onClick={command} />
  );

  const applyLink = () => {
    const value = url().trim();
    const href = value !== "" && !/^[a-z][a-z0-9+.-]*:/i.test(value) ? `https://${value}` : value;
    if (!api?.safeHref(href)) {
      setUrlError(true);
      return;
    }
    setDialog(null);
    cmd((e) => e.setLink(href));
  };

  return (
    <div class={styles["editor"]}>
      <Show when={readable()} fallback={props.unreadable}>
        <Show when={!props.readOnly && active()}>
          {(a) => (
            // Buttons keep the focus (and the selection) in the text.
            <div class={styles["bar"]}>
              <div
                class={styles["toolbar"]}
                role="toolbar"
                aria-label={props.labels.toolbar}
                onMouseDown={(e) => {
                  if ((e.target as HTMLElement).closest("button")) e.preventDefault();
                }}
              >
                <div class={styles["group"]}>
                  <IconButton
                    icon="undo"
                    label={props.labels.undo}
                    disabled={!a().canUndo}
                    onClick={() => cmd((e) => e.history.undo)}
                  />
                  <IconButton
                    icon="redo"
                    label={props.labels.redo}
                    disabled={!a().canRedo}
                    onClick={() => cmd((e) => e.history.redo)}
                  />
                </div>
                <div class={styles["group"]}>
                  {toggle(
                    props.labels.bold,
                    "format_bold",
                    () => a().marks.strong,
                    () => cmd((e) => e.toggle.strong),
                  )}
                  {toggle(
                    props.labels.italic,
                    "format_italic",
                    () => a().marks.em,
                    () => cmd((e) => e.toggle.em),
                  )}
                  {toggle(
                    props.labels.strike,
                    "format_strikethrough",
                    () => a().marks.strike,
                    () => cmd((e) => e.toggle.strike),
                  )}
                  {toggle(
                    props.labels.code,
                    "code",
                    () => a().marks.code,
                    () => cmd((e) => e.toggle.code),
                  )}
                  {toggle(props.labels.link, "link", () => a().marks.link !== null, openLink)}
                </div>
                <div class={styles["group"]}>
                  <For each={[1, 2, 3] as const}>
                    {(level) =>
                      toggle(
                        props.labels.heading(level),
                        `format_h${level}`,
                        () => a().style === `h${level}`,
                        () => cmd((e) => e.setStyle(a().style === `h${level}` ? "paragraph" : `h${level}`)),
                      )
                    }
                  </For>
                </div>
                <div class={styles["group"]}>
                  {toggle(
                    props.labels.bulletList,
                    "format_list_bulleted",
                    () => a().bulletList,
                    () => cmd((e) => e.toggleList("bullet")),
                  )}
                  {toggle(
                    props.labels.orderedList,
                    "format_list_numbered",
                    () => a().orderedList,
                    () => cmd((e) => e.toggleList("ordered")),
                  )}
                  {toggle(
                    props.labels.taskList,
                    "checklist",
                    () => a().taskList,
                    () => cmd((e) => e.toggleList("task")),
                  )}
                </div>
                <div class={styles["group"]}>
                  {toggle(
                    props.labels.quote,
                    "format_quote",
                    () => a().quote,
                    () => cmd((e) => e.toggleQuote()),
                  )}
                  {toggle(
                    props.labels.callout,
                    "lightbulb",
                    () => a().callout !== null,
                    () => {
                      if (a().callout === null) cmd((e) => e.setCallout("note"));
                      else setDialog("callout");
                    },
                  )}
                  {toggle(
                    props.labels.panel,
                    "expansion_panels",
                    () => a().panel,
                    () => cmd((e) => e.insertPanel()),
                  )}
                  {toggle(
                    props.labels.codeBlock,
                    "code_blocks",
                    () => a().style === "code",
                    () => cmd((e) => e.setStyle(a().style === "code" ? "paragraph" : "code")),
                  )}
                  {toggle(
                    props.labels.table,
                    "table",
                    () => a().table,
                    () => {
                      if (a().table) setDialog("table");
                      else cmd((e) => e.insertTable());
                    },
                  )}
                  <IconButton
                    icon="horizontal_rule"
                    label={props.labels.rule}
                    onClick={() => cmd((e) => e.insertRule())}
                  />
                </div>
              </div>
            </div>
          )}
        </Show>
        <div ref={place} class={styles["content"]} data-rich-text />
      </Show>

      <Dialog
        open={dialog() === "link"}
        title={props.labels.link}
        closeLabel={props.labels.close}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Show when={active()?.marks.link !== null}>
              <Button
                variant="danger"
                onClick={() => {
                  setDialog(null);
                  cmd((e) => e.setLink(null));
                }}
              >
                {props.labels.remove}
              </Button>
            </Show>
            <Button onClick={() => setDialog(null)}>{props.labels.cancel}</Button>
            <Button variant="primary" onClick={applyLink}>
              {props.labels.apply}
            </Button>
          </>
        }
      >
        <TextField
          type="url"
          inputMode="url"
          label={props.labels.linkUrl}
          value={url()}
          autocomplete="off"
          error={urlError() ? props.labels.linkInvalid : undefined}
          onInput={(e) => {
            setUrl(e.currentTarget.value);
            setUrlError(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyLink();
            }
          }}
        />
      </Dialog>

      <Dialog
        open={dialog() === "callout"}
        title={props.labels.callout}
        closeLabel={props.labels.close}
        onClose={() => setDialog(null)}
      >
        <Stack gap="xs">
          <For each={CALLOUTS}>
            {(kind) => (
              <Button
                {...(active()?.callout === kind ? { icon: "check" } : {})}
                onClick={() => {
                  setDialog(null);
                  cmd((e) => e.setCallout(kind));
                }}
              >
                {props.labels.calloutKinds[kind]}
              </Button>
            )}
          </For>
          <Button
            variant="danger"
            onClick={() => {
              setDialog(null);
              cmd((e) => e.setCallout(null));
            }}
          >
            {props.labels.remove}
          </Button>
        </Stack>
      </Dialog>

      <Dialog
        open={dialog() === "table"}
        title={props.labels.table}
        closeLabel={props.labels.close}
        onClose={() => setDialog(null)}
      >
        <Stack gap="xs">
          <For
            each={
              [
                ["add_row_below", props.labels.addRow, "addRowAfter"],
                ["add_column_right", props.labels.addColumn, "addColumnAfter"],
                ["delete", props.labels.deleteRow, "deleteRow"],
                ["delete", props.labels.deleteColumn, "deleteColumn"],
              ] as const
            }
          >
            {([icon, label, command]) => (
              <Button
                icon={icon}
                onClick={() => {
                  setDialog(null);
                  cmd((e) => e.table[command]);
                }}
              >
                {label}
              </Button>
            )}
          </For>
          <Button
            variant="danger"
            icon="delete"
            onClick={() => {
              setDialog(null);
              cmd((e) => e.table.deleteTable);
            }}
          >
            {props.labels.deleteTable}
          </Button>
        </Stack>
      </Dialog>
    </div>
  );
}
