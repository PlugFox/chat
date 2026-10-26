/**
 * The note editor's view: ProseMirror over the schema, with history, the
 * Markdown input rules, tables, the gap cursor, task items that tick, and
 * atoms (charts, blocks of an unknown type) drawn by the caller. Plain text
 * pasted outside code is read as Markdown by the document crate (D-096),
 * so a reply copied from a chat keeps its structure and charts.
 */

import { gapCursor } from "prosemirror-gapcursor";
import { history } from "prosemirror-history";
import { Fragment, type Node, Slice } from "prosemirror-model";
import { type Command, EditorState, Plugin } from "prosemirror-state";
import { tableEditing } from "prosemirror-tables";
import { Decoration, DecorationSet, EditorView, type NodeView } from "prosemirror-view";
import { keys, rules, toggleTask } from "./commands";
import { blocksToNodes, type Raw } from "./convert";
import { schema } from "./schema";

export interface EditorOptions {
  doc: Node;
  editable: () => boolean;
  /** The accessible name of the editing area. */
  label: string;
  /** Shown while the note is empty. */
  placeholder: string;
  /** The label of a task item's checkbox. */
  taskLabel: (done: boolean) => string;
  /** After every transaction; `changed` when the document did. */
  onUpdate: (state: EditorState, changed: boolean) => void;
  /** The link key (Mod-k). */
  onLink: () => void;
  /** Draws a chart or an unknown block into `dom`; returns its disposal. */
  renderBlock: (block: Raw, dom: HTMLElement) => () => void;
  /** Markdown to blocks, for pasted plain text; `null` keeps it as text. */
  markdown?: (text: string) => Promise<Raw[] | null>;
}

function placeholder(text: string): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const doc = state.doc;
        const first = doc.firstChild;
        if (doc.childCount !== 1 || first?.type !== schema.nodes.paragraph || first.content.size > 0) return null;
        return DecorationSet.create(doc, [Decoration.node(0, first.nodeSize, { "data-placeholder": text })]);
      },
    },
  });
}

/** A task item: a native checkbox, 48px to hit and drawn small by the editor's styles. */
class TaskView implements NodeView {
  readonly dom: HTMLLIElement;
  readonly contentDOM: HTMLDivElement;
  private readonly box: HTMLInputElement;

  constructor(
    private node: Node,
    view: EditorView,
    getPos: () => number | undefined,
    private readonly label: (done: boolean) => string,
  ) {
    this.dom = document.createElement("li");
    const hit = document.createElement("span");
    hit.contentEditable = "false";
    hit.dataset["task"] = "";
    this.box = document.createElement("input");
    this.box.type = "checkbox";
    this.box.addEventListener("mousedown", (e) => e.preventDefault());
    this.box.addEventListener("change", () => {
      const pos = getPos();
      if (pos !== undefined && view.editable) toggleTask(pos)(view.state, view.dispatch);
      this.sync();
    });
    const drawn = document.createElement("span");
    drawn.dataset["box"] = "";
    hit.append(this.box, drawn);
    this.contentDOM = document.createElement("div");
    this.dom.append(hit, this.contentDOM);
    this.sync();
  }

  private sync(): void {
    const done = this.node.attrs["checked"] === true;
    this.dom.dataset["checked"] = String(done);
    this.box.checked = done;
    this.box.setAttribute("aria-label", this.label(done));
  }

  update(node: Node): boolean {
    if (node.type !== this.node.type || node.attrs["checked"] === null) return false;
    this.node = node;
    this.sync();
    return true;
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    return mutation.type !== "selection" && !this.contentDOM.contains(mutation.target);
  }
}

class AtomView implements NodeView {
  readonly dom: HTMLDivElement;
  private readonly dispose: () => void;

  constructor(node: Node, render: EditorOptions["renderBlock"]) {
    this.dom = document.createElement("div");
    this.dom.contentEditable = "false";
    this.dom.dataset[node.type === schema.nodes.chart ? "chart" : "opaque"] = "";
    const block = (node.type === schema.nodes.chart ? node.attrs["data"] : node.attrs["raw"]) as Raw;
    this.dispose = render(block, this.dom);
  }

  stopEvent(): boolean {
    // Its own controls (a chart's table toggle) work; dragging it moves the block.
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dispose();
  }
}

/** Whether blocks may replace the selection: not inside code or a table cell, which take text only. */
function takesBlocks(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) return true;
  const parent = $from.parent;
  return parent.type === schema.nodes.paragraph || parent.type === schema.nodes.heading;
}

export function createEditor(place: HTMLElement, options: EditorOptions): EditorView {
  let view: EditorView;
  const state = EditorState.create({
    doc: options.doc,
    plugins: [
      rules(),
      ...keys(options.onLink),
      history(),
      gapCursor(),
      tableEditing(),
      placeholder(options.placeholder),
    ],
  });
  // The view takes `place` itself as its editing element.
  view = new EditorView(
    { mount: place },
    {
      state,
      editable: options.editable,
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": options.label,
        spellcheck: "true",
      },
      nodeViews: {
        list_item: (node, v, getPos) => {
          if (node.attrs["checked"] === null) {
            const dom = document.createElement("li");
            return {
              dom,
              contentDOM: dom,
              update: (next) => next.type === node.type && next.attrs["checked"] === null,
            };
          }
          return new TaskView(node, v, getPos, options.taskLabel);
        },
        chart: (node) => new AtomView(node, options.renderBlock),
        opaque: (node) => new AtomView(node, options.renderBlock),
      },
      handlePaste: (_view, event) => {
        const convert = options.markdown;
        const data = event.clipboardData;
        if (!convert || !data || data.types.includes("text/html") || !takesBlocks(view.state)) return false;
        const text = data.getData("text/plain");
        if (text === "") return false;
        event.preventDefault();
        void convert(text).then((blocks) => {
          if (view.isDestroyed) return;
          const nodes = blocks ? blocksToNodes(blocks) : null;
          // One paragraph joins the text around the cursor; anything else comes as blocks.
          const open = nodes?.length === 1 && nodes[0]?.type === schema.nodes.paragraph ? 1 : 0;
          const tr = nodes
            ? view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), open, open))
            : view.state.tr.insertText(text);
          view.dispatch(tr.scrollIntoView());
        });
        return true;
      },
      dispatchTransaction(tr) {
        view.updateState(view.state.apply(tr));
        options.onUpdate(view.state, tr.docChanged);
      },
    },
  );
  return view;
}

/** Replaces the whole document, as for another note or a newer version of this one; history starts over. */
export function replaceDoc(view: EditorView, doc: Node): void {
  view.updateState(EditorState.create({ doc, plugins: view.state.plugins }));
}

export function run(view: EditorView, command: Command): boolean {
  const done = command(view.state, view.dispatch);
  view.focus();
  return done;
}
