/**
 * English messages: the source of every key. ICU MessageFormat syntax
 * (https://unicode-org.github.io/icu/userguide/format_parse/messages/).
 * Keys are `area.name`; add the same key to every other locale.
 */
export const en = {
  "app.name": "Vault Chat",
  "app.skipToContent": "Skip to content",

  "nav.label": "Main",
  "nav.open": "Open navigation",
  "nav.close": "Close navigation",
  "nav.chats": "Chats",
  "nav.notes": "Notebook",
  "nav.registers": "Data",
  "nav.saved": "Saved",
  "nav.settings": "Settings",

  "chats.title": "Chats",
  "chats.empty": "No chats yet. Start one to talk to your assistant.",
  "chats.new": "New chat",
  "notes.title": "Notebook",
  "notes.empty": "No notes yet.",
  "registers.title": "Data",
  "registers.empty": "Track weight, steps and more. Values are encrypted; only you can read them.",
  "saved.title": "Saved messages",
  "saved.empty": "Messages you save appear here.",

  "settings.title": "Settings",
  "settings.appearance": "Appearance",
  "settings.theme": "Theme",
  "settings.theme.system": "System",
  "settings.theme.light": "Light",
  "settings.theme.dark": "Dark",
  "settings.language": "Language",

  "connection.connecting": "Connecting…",
  "connection.waiting": "Connection lost. Retrying in {seconds, plural, one {# second} other {# seconds}}…",
  "connection.revoked": "This session was signed out on another device.",
  "connection.outdated": "A new version is available. Reload the page.",

  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.save": "Save",
  "common.delete": "Delete",
  "common.retry": "Try again",

  "uiKit.title": "UI kit",
  "uiKit.intro": "Every component and variant, for review in every theme and language.",
  "uiKit.buttons": "Buttons",
  "uiKit.fields": "Fields",
  "uiKit.feedback": "Feedback",
  "uiKit.typography": "Typography",
  "uiKit.dialog": "Dialog",
  "uiKit.sample.primary": "Primary",
  "uiKit.sample.secondary": "Secondary",
  "uiKit.sample.danger": "Danger",
  "uiKit.sample.ghost": "Ghost",
  "uiKit.sample.disabled": "Disabled",
  "uiKit.sample.field": "Display name",
  "uiKit.sample.fieldHint": "Shown to you only.",
  "uiKit.sample.fieldError": "Enter a name.",
  "uiKit.sample.info": "Your data is encrypted with keys only your devices hold.",
  "uiKit.sample.success": "Saved.",
  "uiKit.sample.warning": "Write down your recovery key. It is shown only once.",
  "uiKit.sample.danger.text": "Losing every key means losing your data.",
  "uiKit.sample.openDialog": "Open dialog",
  "uiKit.sample.dialogTitle": "Allow access?",
  "uiKit.sample.dialogBody": "The assistant asks to read your steps for the last 7 days.",
  "uiKit.sample.heading": "The quick brown fox",
  "uiKit.sample.body": "Body text sets the reading rhythm of the app. It wraps at a comfortable measure.",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
