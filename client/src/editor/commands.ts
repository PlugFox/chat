/**
 * What the note editor's toolbar and keys do, and what the toolbar shows as
 * active, over the schema in `schema.ts`.
 */
import { baseKeymap, chainCommands, exitCode, lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { redo, redoDepth, undo, undoDepth } from "prosemirror-history";
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, type MarkType, type Node, type NodeType } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import { type Command, type EditorState, type Plugin, TextSelection } from "prosemirror-state";
import {
  addColumnAfter,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  goToNextCell,
  isInTable,
} from "prosemirror-tables";
import { schema } from "./schema";

const n = schema.nodes;
const m = schema.marks;

/** The kind of block the selection starts in, as the toolbar's style select names it. */
export type TextStyle = "paragraph" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "code";

export interface Active {
  marks: { strong: boolean; em: boolean; strike: boolean; code: boolean; link: string | null };
  style: TextStyle | null;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  quote: boolean;
  callout: string | null;
  panel: boolean;
  table: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function linkAt(state: EditorState): string | null {
  const { $from, from, to, empty } = state.selection;
  const at = (marks: readonly { type: MarkType; attrs: Record<string, unknown> }[]) =>
    marks.find((mark) => mark.type === m.link)?.attrs["href"];
  if (empty) return (at($from.marks()) as string | undefined) ?? null;
  let href: string | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    href ??= (at(node.marks) as string | undefined) ?? null;
  });
  return href;
}

/** The innermost ancestor of the selection of one of `types`. */
function ancestor(state: EditorState, ...types: NodeType[]): Node | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d -= 1) {
    const node = $from.node(d);
    if (types.includes(node.type)) return node;
  }
  return null;
}

export function active(state: EditorState): Active {
  const parent = state.selection.$from.parent;
  let style: TextStyle | null = null;
  if (parent.type === n.paragraph) style = "paragraph";
  else if (parent.type === n.heading) style = `h${parent.attrs["level"] as 1 | 2 | 3 | 4 | 5 | 6}`;
  else if (parent.type === n.code_block) style = "code";
  const list = ancestor(state, n.bullet_list, n.ordered_list);
  const item = ancestor(state, n.list_item);
  const task = item !== null && item.attrs["checked"] !== null;
  const callout = ancestor(state, n.callout);
  return {
    marks: {
      strong: markActive(state, m.strong),
      em: markActive(state, m.em),
      strike: markActive(state, m.strike),
      code: markActive(state, m.code),
      link: linkAt(state),
    },
    style,
    bulletList: list?.type === n.bullet_list && !task,
    orderedList: list?.type === n.ordered_list,
    taskList: list !== null && task,
    quote: ancestor(state, n.blockquote) !== null,
    callout: callout ? (callout.attrs["kind"] as string) : null,
    panel: ancestor(state, n.panel) !== null,
    table: isInTable(state),
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
  };
}

export const toggle = {
  strong: toggleMark(m.strong),
  em: toggleMark(m.em),
  strike: toggleMark(m.strike),
  code: toggleMark(m.code),
};

export function setStyle(style: TextStyle): Command {
  if (style === "paragraph") return setBlockType(n.paragraph);
  if (style === "code") return setBlockType(n.code_block);
  return setBlockType(n.heading, { level: Number(style.slice(1)) });
}

/** Sets a link on the selection, or takes it off with `null`; with an empty selection, inserts `href` as its text. */
export function setLink(href: string | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    const type = m.link;
    if (!dispatch) return true;
    let tr = state.tr;
    if (empty) {
      if (href === null) {
        // The whole link around the cursor.
        const $pos = state.selection.$from;
        const start = $pos.parent.childAfter($pos.parentOffset);
        if (!start.node) return false;
        const at = $pos.start() + start.offset;
        tr = tr.removeMark(at, at + start.node.nodeSize, type);
      } else {
        tr = tr.insert(from, schema.text(href, [type.create({ href })]));
      }
    } else {
      tr = tr.removeMark(from, to, type);
      if (href !== null) tr = tr.addMark(from, to, type.create({ href }));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Wraps the selection in a list of `type`, or unwraps it when it is in one already; `task` makes the items tasks. */
export function toggleList(type: "bullet" | "ordered" | "task"): Command {
  return (state, dispatch) => {
    const now = active(state);
    const on = type === "bullet" ? now.bulletList : type === "ordered" ? now.orderedList : now.taskList;
    if (on) return liftListItem(n.list_item)(state, dispatch);
    const listType = type === "ordered" ? n.ordered_list : n.bullet_list;
    const inList = now.bulletList || now.orderedList || now.taskList;
    let tr = state.tr;
    if (!inList) {
      let wrapped = false;
      wrapInList(listType)(state, (t) => {
        tr = t;
        wrapped = true;
      });
      if (!wrapped) return false;
    }
    if (!dispatch) return true;
    // Retype the list around the selection and mark its items.
    const $from = tr.selection.$from;
    for (let d = $from.depth; d > 0; d -= 1) {
      const node = $from.node(d);
      if (node.type !== n.bullet_list && node.type !== n.ordered_list) continue;
      const pos = $from.before(d);
      if (node.type !== listType)
        tr = tr.setNodeMarkup(pos, listType, listType === n.ordered_list ? { order: 1 } : null);
      node.forEach((_item, offset) => {
        tr = tr.setNodeAttribute(pos + 1 + offset, "checked", type === "task" ? false : null);
      });
      break;
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Ticks or unticks the task item at `pos`. */
export function toggleTask(pos: number): Command {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (node?.type !== n.list_item || node.attrs["checked"] === null) return false;
    dispatch?.(state.tr.setNodeAttribute(pos, "checked", !node.attrs["checked"]));
    return true;
  };
}

export function toggleQuote(): Command {
  return (state, dispatch) => (active(state).quote ? lift(state, dispatch) : wrapIn(n.blockquote)(state, dispatch));
}

/** Wraps the selection in a callout of `kind`, changes the kind of the one it is in, or with `null` unwraps it. */
export function setCallout(kind: string | null): Command {
  return (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d -= 1) {
      if ($from.node(d).type !== n.callout) continue;
      if (kind === null) return lift(state, dispatch);
      dispatch?.(state.tr.setNodeAttribute($from.before(d), "kind", kind));
      return true;
    }
    return kind !== null && wrapIn(n.callout, { kind })(state, dispatch);
  };
}

/** Wraps the selected blocks in a panel with an empty title, the cursor in the title. */
export function insertPanel(): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection;
    const range = $from.blockRange($to);
    if (!range) return false;
    const blocks: Node[] = [];
    for (let i = range.startIndex; i < range.endIndex; i += 1) blocks.push(range.parent.child(i));
    const panel = n.panel.createChecked(null, [n.panel_title.create(), ...blocks]);
    if (!range.parent.canReplace(range.startIndex, range.endIndex, Fragment.from(panel))) return false;
    if (dispatch) {
      const tr = state.tr.replaceWith(range.start, range.end, panel);
      dispatch(tr.setSelection(TextSelection.create(tr.doc, range.start + 2)).scrollIntoView());
    }
    return true;
  };
}

/** Inserts a block after the one the selection ends in, at the innermost level that takes it, and a paragraph after it at the end. */
function insertBlock(make: () => Node, inside: number): Command {
  return (state, dispatch) => {
    const { $to } = state.selection;
    const node = make();
    for (let d = $to.depth; d > 0; d -= 1) {
      const index = $to.indexAfter(d - 1);
      if (!$to.node(d - 1).canReplaceWith(index, index, node.type)) continue;
      if (dispatch) {
        const pos = $to.after(d);
        let tr = state.tr.insert(pos, node);
        if (tr.doc.resolve(pos + node.nodeSize).nodeAfter === null) {
          tr = tr.insert(pos + node.nodeSize, n.paragraph.create());
        }
        dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(pos + inside))).scrollIntoView());
      }
      return true;
    }
    return false;
  };
}

export function insertRule(): Command {
  return insertBlock(() => n.horizontal_rule.create(), 1);
}

/** A table of a head row and two rows of three columns, the cursor in its first cell. */
export function insertTable(): Command {
  const row = (header: boolean) =>
    n.table_row.create(
      null,
      [0, 1, 2].map(() => (header ? n.table_header : n.table_cell).create()),
    );
  return insertBlock(() => n.table.create(null, [row(true), row(false), row(false)]), 3);
}

export const table = { addRowAfter, addColumnAfter, deleteRow, deleteColumn, deleteTable };

export const history = { undo, redo };

function markRule(pattern: RegExp, type: MarkType): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const text = match[1];
    if (!text) return null;
    const tr = state.tr.replaceWith(start, end, schema.text(text, [type.create()]));
    return tr.removeStoredMark(type);
  });
}

/** Markdown typed at the start of a block or around a word becomes what it means. */
export function rules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, n.heading, (match) => ({ level: match[1]?.length ?? 1 })),
      wrappingInputRule(/^\s*>\s$/, n.blockquote),
      wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list),
      wrappingInputRule(
        /^(\d+)\.\s$/,
        n.ordered_list,
        (match) => ({ order: Number(match[1]) }),
        (match, node) => node.childCount + (node.attrs["order"] as number) === Number(match[1]),
      ),
      new InputRule(/^\[( |x)\]\s$/, (state, match, start, end) => {
        const $start = state.doc.resolve(start);
        const item = $start.node(-1);
        if (item?.type !== n.list_item) return null;
        return state.tr.delete(start, end).setNodeAttribute($start.before(-1), "checked", match[1] === "x");
      }),
      textblockTypeInputRule(/^```([\w-]*)\s$/, n.code_block, (match) => ({ lang: match[1] || null })),
      new InputRule(/^(?:---|\*\*\*|___)$/, (state, _match, start) => {
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== n.paragraph || $start.depth < 1) return null;
        return state.tr.replaceRangeWith($start.before(), $start.after(), n.horizontal_rule.create());
      }),
      markRule(/\*\*([^*]+)\*\*$/, m.strong),
      markRule(/(?<![*\w])\*([^*\s][^*]*)\*$/, m.em),
      markRule(/~~([^~]+)~~$/, m.strike),
      markRule(/`([^`]+)`$/, m.code),
    ],
  });
}

/** The editor's keys, before ProseMirror's base keymap. */
export function keys(onLink: () => void): Plugin[] {
  const item = n.list_item;
  const breakLine: Command = chainCommands(exitCode, (state, dispatch) => {
    dispatch?.(state.tr.replaceSelectionWith(n.hard_break.create()).scrollIntoView());
    return true;
  });
  return [
    keymap({
      "Mod-z": undo,
      "Shift-Mod-z": redo,
      "Mod-y": redo,
      Backspace: undoInputRule,
      "Mod-b": toggle.strong,
      "Mod-i": toggle.em,
      "Mod-e": toggle.code,
      "Shift-Mod-s": toggle.strike,
      "Mod-k": () => {
        onLink();
        return true;
      },
      "Shift-Enter": breakLine,
      "Mod-Enter": breakLine,
      Enter: splitListItem(item),
      Tab: chainCommands(goToNextCell(1), sinkListItem(item)),
      "Shift-Tab": chainCommands(goToNextCell(-1), liftListItem(item)),
      "Shift-Mod-0": setBlockType(n.paragraph),
      "Shift-Mod-1": setBlockType(n.heading, { level: 1 }),
      "Shift-Mod-2": setBlockType(n.heading, { level: 2 }),
      "Shift-Mod-3": setBlockType(n.heading, { level: 3 }),
    }),
    keymap(baseKeymap),
  ];
}
