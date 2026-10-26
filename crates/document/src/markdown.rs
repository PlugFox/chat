//! Markdown to a document, one pass over pulldown-cmark's events. Inline
//! text outside a paragraph (a tight list item) gets a paragraph of its own;
//! a container past `DEPTH_MAX` is skipped and its blocks land in the one
//! that holds it.

use pulldown_cmark::{Alignment, BlockQuoteKind, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

use crate::{Align, Block, CalloutKind, DEPTH_MAX, Document, Item, Span, VERSION, chart, flag, safe_href};

/// The document of a model's Markdown (docs/crypto.md, "Message documents").
pub fn from_markdown(text: &str) -> Document {
    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS | Options::ENABLE_GFM;
    let mut builder = Builder {
        stack: vec![Frame::Blocks(Container::Root, Vec::new())],
        styles: Vec::new(),
        links: Vec::new(),
        images: Vec::new(),
    };
    for event in Parser::new_ext(text, options) {
        builder.event(event);
    }
    builder.close_implicit();
    let blocks = match builder.stack.swap_remove(0) {
        Frame::Blocks(_, blocks) => blocks,
        _ => Vec::new(),
    };
    Document { v: VERSION, blocks }
}

enum Container {
    Root,
    Quote,
    Callout(CalloutKind),
    Item(Option<bool>),
}

#[derive(PartialEq)]
enum Inline {
    Paragraph,
    /// Text outside a paragraph; closed by the next block event.
    Implicit,
    Heading(u8),
    Cell,
}

enum Frame {
    Blocks(Container, Vec<Block>),
    List(Option<u32>, Vec<Item>),
    /// A container past `DEPTH_MAX`.
    Skipped,
    Inline(Inline, Vec<(String, u8, Option<String>)>),
    Code(Option<String>, String),
    Table {
        align: Vec<Align>,
        head: Vec<Vec<Span>>,
        rows: Vec<Vec<Vec<Span>>>,
        row: Vec<Vec<Span>>,
    },
}

struct Builder {
    stack: Vec<Frame>,
    styles: Vec<u8>,
    links: Vec<Option<String>>,
    /// Open images: the spans their paragraph held, and their address.
    images: Vec<(usize, Option<String>)>,
}

impl Builder {
    fn event(&mut self, event: Event<'_>) {
        match event {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(text) | Event::InlineHtml(text) | Event::Html(text) => self.text(&text, 0),
            Event::Code(text) => self.text(&text, flag::CODE),
            Event::SoftBreak | Event::HardBreak => self.text("\n", 0),
            Event::Rule => {
                self.close_implicit();
                self.emit(Block::Rule);
            }
            Event::TaskListMarker(done) => {
                if let Some(Frame::Blocks(Container::Item(checked), _)) = self.stack.last_mut() {
                    *checked = Some(done);
                }
            }
            // Not enabled: math, footnotes.
            Event::InlineMath(text) | Event::DisplayMath(text) | Event::FootnoteReference(text) => self.text(&text, 0),
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            Tag::Paragraph | Tag::HtmlBlock => self.open(Frame::Inline(Inline::Paragraph, Vec::new())),
            Tag::Heading { level, .. } => self.open(Frame::Inline(Inline::Heading(heading(level)), Vec::new())),
            Tag::BlockQuote(kind) => {
                let container = kind.map_or(Container::Quote, |k| Container::Callout(callout(k)));
                self.open_container(Frame::Blocks(container, Vec::new()));
            }
            Tag::CodeBlock(kind) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.split_whitespace().next().map(str::to_owned),
                    CodeBlockKind::Indented => None,
                };
                self.open(Frame::Code(lang, String::new()));
            }
            Tag::List(start) => {
                let start = start.map(|n| u32::try_from(n).unwrap_or(u32::MAX));
                self.open_container(Frame::List(start, Vec::new()));
            }
            Tag::Item => {
                self.close_implicit();
                let frame = match self.stack.last() {
                    Some(Frame::List(..)) => Frame::Blocks(Container::Item(None), Vec::new()),
                    _ => Frame::Skipped,
                };
                self.stack.push(frame);
            }
            Tag::Table(aligns) => self.open(Frame::Table {
                align: aligns.into_iter().map(align).collect(),
                head: Vec::new(),
                rows: Vec::new(),
                row: Vec::new(),
            }),
            Tag::TableCell => self.stack.push(Frame::Inline(Inline::Cell, Vec::new())),
            Tag::Emphasis => self.styles.push(flag::ITALIC),
            Tag::Strong => self.styles.push(flag::BOLD),
            Tag::Strikethrough => self.styles.push(flag::STRIKE),
            Tag::Link { dest_url, .. } => self.links.push(safe_href(&dest_url)),
            // An image is a link to it: no message loads anything by itself.
            Tag::Image { dest_url, .. } => {
                self.ensure_inline();
                self.images.push((self.spans(), safe_href(&dest_url)));
                self.links.push(safe_href(&dest_url));
            }
            _ => {}
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph | TagEnd::HtmlBlock | TagEnd::Heading(_) => self.close_inline(),
            TagEnd::BlockQuote(_) | TagEnd::List(_) => {
                self.close_implicit();
                match self.stack.pop() {
                    Some(Frame::Blocks(Container::Quote, b)) => self.emit(Block::Quote { b }),
                    Some(Frame::Blocks(Container::Callout(kind), b)) => self.emit(Block::Callout { kind, b }),
                    Some(Frame::List(start, items)) => self.emit(Block::List { start, items }),
                    _ => {}
                }
            }
            TagEnd::Item => {
                self.close_implicit();
                if let Some(Frame::Blocks(Container::Item(checked), b)) = self.stack.pop()
                    && let Some(Frame::List(_, items)) = self.stack.last_mut()
                {
                    items.push(Item { b, checked });
                }
            }
            TagEnd::CodeBlock => {
                if let Some(Frame::Code(lang, mut text)) = self.stack.pop() {
                    if text.ends_with('\n') {
                        text.pop();
                    }
                    match lang.as_deref().filter(|l| *l == "chart").and_then(|_| chart::from_json(&text)) {
                        Some(chart) => self.emit(Block::Chart(chart)),
                        None => self.emit(Block::Code { lang, text }),
                    }
                }
            }
            TagEnd::TableCell => {
                if let Some(Frame::Inline(_, spans)) = self.stack.pop()
                    && let Some(Frame::Table { row, .. }) = self.stack.last_mut()
                {
                    row.push(merge(spans));
                }
            }
            TagEnd::TableHead => {
                if let Some(Frame::Table { head, row, .. }) = self.stack.last_mut() {
                    *head = std::mem::take(row);
                }
            }
            TagEnd::TableRow => {
                if let Some(Frame::Table { head, rows, row, .. }) = self.stack.last_mut() {
                    let mut cells = std::mem::take(row);
                    cells.resize_with(head.len(), Vec::new);
                    rows.push(cells);
                }
            }
            TagEnd::Table => {
                if let Some(Frame::Table { align, head, rows, .. }) = self.stack.pop() {
                    self.emit(Block::Table { align, head, rows });
                }
            }
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough => {
                self.styles.pop();
            }
            TagEnd::Link => {
                self.links.pop();
            }
            TagEnd::Image => {
                // An image without alt text shows its address.
                if let Some((before, href)) = self.images.pop()
                    && self.spans() == before
                    && let Some(href) = href
                {
                    self.text(&href.clone(), 0);
                }
                self.links.pop();
            }
            _ => {}
        }
    }

    /// Pushes a block-level frame after closing any implicit paragraph.
    fn open(&mut self, frame: Frame) {
        self.close_implicit();
        self.stack.push(frame);
    }

    fn open_container(&mut self, frame: Frame) {
        let depth = self
            .stack
            .iter()
            .filter(|f| matches!(f, Frame::List(..) | Frame::Blocks(Container::Quote | Container::Callout(_), _)))
            .count();
        self.open(if depth < DEPTH_MAX { frame } else { Frame::Skipped });
    }

    fn ensure_inline(&mut self) {
        if !matches!(self.stack.last(), Some(Frame::Inline(..) | Frame::Code(..))) {
            self.stack.push(Frame::Inline(Inline::Implicit, Vec::new()));
        }
    }

    fn spans(&self) -> usize {
        match self.stack.last() {
            Some(Frame::Inline(_, spans)) => spans.len(),
            _ => 0,
        }
    }

    fn text(&mut self, text: &str, extra: u8) {
        self.ensure_inline();
        let f = self.styles.iter().fold(extra, |f, s| f | s);
        let href = self.links.last().cloned().flatten();
        match self.stack.last_mut() {
            Some(Frame::Code(_, code)) => code.push_str(text),
            Some(Frame::Inline(_, spans)) => match spans.last_mut() {
                Some((last, lf, lh)) if *lf == f && *lh == href => last.push_str(text),
                _ => spans.push((text.to_owned(), f, href)),
            },
            _ => {}
        }
    }

    fn close_implicit(&mut self) {
        if matches!(self.stack.last(), Some(Frame::Inline(Inline::Implicit, _))) {
            self.close_inline();
        }
    }

    fn close_inline(&mut self) {
        let Some(Frame::Inline(kind, spans)) = self.stack.pop() else { return };
        let mut s = merge(spans);
        if kind == Inline::Paragraph {
            // An HTML block ends with its line break.
            if let Some(Span::Plain(last)) = s.last_mut()
                && last.ends_with('\n')
            {
                last.pop();
            }
        }
        if s.is_empty() {
            return;
        }
        self.emit(match kind {
            Inline::Heading(level) => Block::Heading { level, s },
            _ => Block::Paragraph { s },
        });
    }

    /// Adds a block to the nearest container (past skipped ones).
    fn emit(&mut self, block: Block) {
        if let Some(Frame::Blocks(_, blocks)) = self.stack.iter_mut().rev().find(|f| matches!(f, Frame::Blocks(..))) {
            blocks.push(block);
        }
    }
}

fn merge(spans: Vec<(String, u8, Option<String>)>) -> Vec<Span> {
    spans.into_iter().filter(|(text, ..)| !text.is_empty()).map(|(text, f, href)| Span::new(text, f, href)).collect()
}

fn heading(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

fn callout(kind: BlockQuoteKind) -> CalloutKind {
    match kind {
        BlockQuoteKind::Note => CalloutKind::Note,
        BlockQuoteKind::Tip => CalloutKind::Tip,
        BlockQuoteKind::Important => CalloutKind::Important,
        BlockQuoteKind::Warning => CalloutKind::Warning,
        BlockQuoteKind::Caution => CalloutKind::Caution,
    }
}

fn align(a: Alignment) -> Align {
    match a {
        Alignment::None => Align::None,
        Alignment::Left => Align::Left,
        Alignment::Center => Align::Center,
        Alignment::Right => Align::Right,
    }
}
