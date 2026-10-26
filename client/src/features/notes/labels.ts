/** The note editor's labels in the current locale, for the notes and the UI kit. */
import type { RichEditorLabels } from "../../design-system/components";
import { useI18n } from "../../i18n/i18n";
import { useRichTools } from "../chats/rich";

export function useEditorLabels(): () => RichEditorLabels {
  const { t } = useI18n();
  const rich = useRichTools();
  return (): RichEditorLabels => ({
    area: t("notes.editor.area"),
    placeholder: t("notes.editor.placeholder"),
    toolbar: t("notes.editor.toolbar"),
    heading: (level) => t("notes.editor.heading", { level }),
    bold: t("notes.editor.bold"),
    italic: t("notes.editor.italic"),
    strike: t("notes.editor.strike"),
    code: t("notes.editor.code"),
    link: t("notes.editor.link"),
    bulletList: t("notes.editor.bulletList"),
    orderedList: t("notes.editor.orderedList"),
    taskList: t("notes.editor.taskList"),
    quote: t("notes.editor.quote"),
    callout: t("notes.editor.callout"),
    panel: t("notes.editor.panel"),
    codeBlock: t("notes.editor.codeBlock"),
    table: t("notes.editor.table"),
    rule: t("notes.editor.rule"),
    undo: t("notes.editor.undo"),
    redo: t("notes.editor.redo"),
    close: t("common.close"),
    cancel: t("common.cancel"),
    apply: t("notes.editor.apply"),
    remove: t("notes.editor.remove"),
    linkUrl: t("notes.editor.linkUrl"),
    linkInvalid: t("notes.editor.linkInvalid"),
    calloutKinds: rich.labels().callout,
    addRow: t("notes.editor.addRow"),
    addColumn: t("notes.editor.addColumn"),
    deleteRow: t("notes.editor.deleteRow"),
    deleteColumn: t("notes.editor.deleteColumn"),
    deleteTable: t("notes.editor.deleteTable"),
    rich: rich.labels(),
  });
}
