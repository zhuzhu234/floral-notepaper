import type { Annotation, Extension, Range } from "@codemirror/state";
import {
  EditorSelection,
  EditorState,
  Facet,
  Prec,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";
import { ensureSyntaxTree, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import katex from "katex";
import "katex/dist/katex.min.css";
import { resolveMarkdownImageSrc } from "./imageSrc";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Live Preview：单栏、所见即所得地编辑 Markdown。
 *
 * 文档本身始终是纯 Markdown，装饰层只做两件事：
 * 1. 光标不在的语法节点，把标记符号（`**`、`#`、反引号等）替换成隐藏装饰，
 *    并给内容套上排版用的 mark / line 装饰，看起来就是渲染后的样子；
 * 2. 光标进入的节点重新露出标记，可以直接改源码。
 *
 * 因为只有一份文档、一套 DOM，不存在分栏滚动不同步或预览滞后的割裂感，
 * 所有修改也始终落在同一份 Markdown 文本上。
 */

export interface LivePreviewOptions {
  /** 笔记图片目录：把 `images/xxx.png` 解析成 WebView 能显示的地址 */
  imageBaseDir?: string;
  /** 自定义图片地址转换（默认使用与预览区一致的解析规则） */
  resolveImageSrc?: (src: string) => string;
  /** 点击任务列表复选框；不传则直接改文档 */
  onToggleTask?: (offset: number, checked: boolean) => void;
}

const optionsFacet = Facet.define<LivePreviewOptions, LivePreviewOptions>({
  combine: (values) => values[values.length - 1] ?? {},
});

/** 编辑器是否有焦点；失焦时隐藏所有语法标记，只保留排版结果 */
export const setEditorActive = StateEffect.define<boolean>();

const editorActiveField = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditorActive)) return effect.value;
    }
    return value;
  },
});

/* ─────────────────────────── 装饰常量 ─────────────────────────── */

const hide = Decoration.replace({});

const markStrong = Decoration.mark({ class: "cm-lp-strong" });
const markEmphasis = Decoration.mark({ class: "cm-lp-em" });
const markStrike = Decoration.mark({ class: "cm-lp-strike" });
const markInlineCode = Decoration.mark({ class: "cm-lp-inline-code" });
const markLink = Decoration.mark({ class: "cm-lp-link" });
const markLinkUrl = Decoration.mark({ class: "cm-lp-link-url" });
const markOrderedMark = Decoration.mark({ class: "cm-lp-ordered-mark" });
const markTableCell = Decoration.mark({ class: "cm-lp-cell" });
const markCodeInfo = Decoration.mark({ class: "cm-lp-code-info" });
const markCodeText = Decoration.mark({ class: "cm-lp-code-text" });

const HEADING_CLASSES = [
  "cm-lp-heading cm-lp-h1",
  "cm-lp-heading cm-lp-h2",
  "cm-lp-heading cm-lp-h3",
  "cm-lp-heading cm-lp-h4",
  "cm-lp-heading cm-lp-h5",
  "cm-lp-heading cm-lp-h6",
];

const LINE_QUOTE = "cm-lp-quote";
const LINE_CODE = "cm-lp-code-line";
const LINE_TABLE = "cm-lp-table-line";
const LINE_TABLE_HEADER = "cm-lp-table-line cm-lp-table-header";
const LINE_LINK_REFERENCE = "cm-lp-link-reference";
const LINE_COLLAPSED = "cm-lp-collapsed-line";
const LINE_RULE = "cm-lp-hr-line";

/** 这些节点内部是字面文本，不再做行内排版 */
const literalInline = new Set(["InlineCode", "CodeText", "HTMLTag", "HTMLBlock", "Comment"]);

interface BuildContext {
  state: EditorState;
  options: LivePreviewOptions;
  ranges: Array<Range<Decoration>>;
  /** 已被整行块级替换的行号，这些行不能再叠加行装饰 */
  replacedLines: Set<number>;
  /** 已添加的行装饰，避免嵌套块重复添加 */
  lines: Set<string>;
}

/* ─────────────────────────── 工具 ─────────────────────────── */

/**
 * 选区（含光标）是否与 [from, to] 相接：光标贴住节点边界时也视为进入该节点。
 * `active` 为 false（编辑器失焦）时一律返回 false，整篇都按渲染后的样子显示。
 */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  // 字段缺失（未安装本扩展时）按"有焦点"处理
  if (state.field(editorActiveField, false) === false) return false;
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function lineSpan(state: EditorState, from: number, to: number) {
  const safeFrom = Math.max(0, Math.min(from, state.doc.length));
  const safeTo = Math.max(safeFrom, Math.min(to, state.doc.length));
  const start = state.doc.lineAt(safeFrom);
  const end = state.doc.lineAt(safeTo);
  return { from: start.from, to: end.to, firstLine: start.number, lastLine: end.number };
}

function push(ctx: BuildContext, deco: Decoration, from: number, to: number) {
  if (to < from || from < 0 || to > ctx.state.doc.length) return;
  ctx.ranges.push(deco.range(from, to));
}

function pushLine(ctx: BuildContext, linePos: number, className: string) {
  const lineNumber = ctx.state.doc.lineAt(linePos).number;
  if (ctx.replacedLines.has(lineNumber)) return;
  const key = `${linePos}:${className}`;
  if (ctx.lines.has(key)) return;
  ctx.lines.add(key);
  push(ctx, Decoration.line({ class: className }), linePos, linePos);
}

/**
 * 折叠一整行纯语法（代码围栏、表格分隔行）：给该行加零高度样式，
 * 并把行内文本隐藏。不用块级替换，是因为块级替换会连带吃掉
 * 相邻行的 line 装饰（紧邻的代码行会因此丢样式）。
 */
function collapseLine(ctx: BuildContext, lineNumber: number) {
  if (ctx.replacedLines.has(lineNumber)) return;
  const line = ctx.state.doc.line(lineNumber);
  ctx.replacedLines.add(lineNumber);
  ctx.lines.add(`${line.from}:${LINE_COLLAPSED}`);
  push(ctx, Decoration.line({ class: LINE_COLLAPSED }), line.from, line.from);
  push(ctx, hide, line.from, line.to);
}

/** 隐藏行内标记；调用前必须保证区间内没有换行 */
function hideInline(ctx: BuildContext, from: number, to: number) {
  if (to > from) push(ctx, hide, from, to);
}

/** 返回 from 之后连续空白的结束位置（不跨行），用于 `#`、`-`、`>` 之后的间隔 */
function trailingSpaceEnd(ctx: BuildContext, from: number): number {
  const line = ctx.state.doc.lineAt(from);
  let end = from;
  while (end < line.to) {
    const char = ctx.state.doc.sliceString(end, end + 1);
    if (char !== " " && char !== "\t") break;
    end++;
  }
  return end;
}

/** 子节点列表：Lezer 的 SyntaxNode 只暴露 firstChild/nextSibling 链 */
function childrenOf(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}

function childOf(node: SyntaxNode, name: string): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child;
  }
  return null;
}

function isBlank(text: string) {
  return text.trim().length === 0;
}

/* ─────────────────────────── 行内 ─────────────────────────── */

function buildInline(ctx: BuildContext, node: SyntaxNode) {
  if (literalInline.has(node.name)) {
    // 行内代码 / 代码文本内部按原样显示，但仍要隐藏反引号
    if (node.name === "InlineCode") buildInlineCode(ctx, node);
    return;
  }

  const reveal = selectionTouches(ctx.state, node.from, node.to);

  switch (node.name) {
    case "StrongEmphasis":
    case "Emphasis":
    case "Strikethrough": {
      const deco =
        node.name === "StrongEmphasis"
          ? markStrong
          : node.name === "Emphasis"
            ? markEmphasis
            : markStrike;
      if (!reveal) {
        push(ctx, deco, node.from, node.to);
        for (const mark of childrenOf(node)) {
          if (mark.name.endsWith("Mark")) hideInline(ctx, mark.from, mark.to);
        }
      }
      for (const child of childrenOf(node)) {
        if (child.name.endsWith("Mark")) continue;
        buildInline(ctx, child);
      }
      return;
    }
    case "InlineCode":
      buildInlineCode(ctx, node);
      return;
    case "InlineMath": {
      if (reveal) return;
      const source = ctx.state.doc.sliceString(node.from, node.to);
      push(
        ctx,
        Decoration.replace({ widget: new MathWidget(source.slice(1, -1), false, node.from) }),
        node.from,
        node.to,
      );
      return;
    }
    case "Autolink": {
      if (reveal) return;
      for (const mark of childrenOf(node)) {
        if (mark.name === "LinkMark") hideInline(ctx, mark.from, mark.to);
      }
      push(ctx, markLink, node.from, node.to);
      return;
    }
    case "Link": {
      if (reveal) return;
      const marks = childrenOf(node).filter((child) => child.name === "LinkMark");
      if (marks.length >= 2) {
        const open = marks[0];
        const close = marks[1];
        // `[` 与 `](url "title")` 隐藏，只留下链接文字
        hideInline(ctx, open.from, open.to);
        hideInline(ctx, close.from, node.to);
        if (close.from > open.to) push(ctx, markLink, open.to, close.from);
        for (const child of childrenOf(node)) {
          if (child.name === "LinkMark" || child.name === "URL") continue;
          if (child.from >= open.to && child.to <= close.from) buildInline(ctx, child);
        }
      }
      return;
    }
    case "URL":
      push(ctx, markLinkUrl, node.from, node.to);
      return;
    case "Image": {
      if (reveal) return;
      const urlNode = childOf(node, "URL");
      const marks = childrenOf(node).filter((child) => child.name === "LinkMark");
      if (!urlNode || marks.length < 2) return;
      const src = ctx.state.doc.sliceString(urlNode.from, urlNode.to);
      const alt = ctx.state.doc.sliceString(marks[0].to, marks[1].from);
      const resolved = ctx.options.resolveImageSrc
        ? ctx.options.resolveImageSrc(src)
        : resolveMarkdownImageSrc(src, ctx.options.imageBaseDir, convertFileSrc);
      push(
        ctx,
        Decoration.replace({ widget: new ImageWidget(resolved, alt, node.from) }),
        node.from,
        node.to,
      );
      return;
    }
    default:
      break;
  }

  for (const child of childrenOf(node)) buildInline(ctx, child);
}

function buildInlineCode(ctx: BuildContext, node: SyntaxNode) {
  const reveal = selectionTouches(ctx.state, node.from, node.to);
  if (reveal) return;
  for (const mark of childrenOf(node)) {
    if (mark.name === "CodeMark") hideInline(ctx, mark.from, mark.to);
  }
  push(ctx, markInlineCode, node.from, node.to);
}

/* ─────────────────────────── 块级 ─────────────────────────── */

function buildBlock(ctx: BuildContext, node: SyntaxNode) {
  switch (node.name) {
    case "ATXHeading1":
    case "ATXHeading2":
    case "ATXHeading3":
    case "ATXHeading4":
    case "ATXHeading5":
    case "ATXHeading6":
    case "SetextHeading1":
    case "SetextHeading2":
      buildHeading(ctx, node);
      return;
    case "Paragraph":
      buildParagraph(ctx, node);
      return;
    case "Blockquote":
      buildBlockquote(ctx, node);
      return;
    case "BulletList":
    case "OrderedList":
      buildList(ctx, node);
      return;
    case "ListItem":
      buildListItem(ctx, node, false);
      return;
    case "FencedCode":
    case "CodeBlock":
      buildCodeBlock(ctx, node);
      return;
    case "HorizontalRule":
      buildHorizontalRule(ctx, node);
      return;
    case "Table":
      buildTable(ctx, node);
      return;
    case "LinkReference":
      pushLine(ctx, ctx.state.doc.lineAt(node.from).from, LINE_LINK_REFERENCE);
      return;
    case "Task":
      buildTask(ctx, node);
      return;
    case "Document":
      for (const child of childrenOf(node)) buildBlock(ctx, child);
      return;
    default:
      break;
  }

  for (const child of childrenOf(node)) buildBlock(ctx, child);
}

function buildHeading(ctx: BuildContext, node: SyntaxNode) {
  const level = Number(node.name.slice(-1));
  const span = lineSpan(ctx.state, node.from, node.to);
  const reveal = selectionTouches(ctx.state, span.from, span.to);

  if (!reveal) {
    for (const mark of childrenOf(node)) {
      if (mark.name !== "HeaderMark") continue;
      const markLine = ctx.state.doc.lineAt(mark.from);
      if (markLine.from === mark.from && markLine.to === mark.to) {
        // Setext 标题的 `===` / `---` 独占一行，整行隐藏
        collapseLine(ctx, markLine.number);
      } else {
        // `#` 与正文之间的空格一并隐藏，标题才贴齐左边界
        hideInline(ctx, mark.from, trailingSpaceEnd(ctx, mark.to));
      }
    }
  }

  const firstLine = ctx.state.doc.lineAt(node.from).number;
  pushLine(ctx, ctx.state.doc.line(firstLine).from, HEADING_CLASSES[Math.min(level, 6) - 1]);
  for (const child of childrenOf(node)) {
    if (child.name === "HeaderMark") continue;
    buildInline(ctx, child);
  }
}

function buildParagraph(ctx: BuildContext, node: SyntaxNode) {
  const span = lineSpan(ctx.state, node.from, node.to);
  const text = ctx.state.doc.sliceString(node.from, node.to).trim();

  // 独占一段的 `$$ ... $$` 渲染成块级公式。
  // 注意：这里刻意不用 block 级替换——块替换的高度测量与真实渲染存在
  // 少量误差，且每个块都会累积，文档里出现几个公式后点击就会明显偏移。
  // 改成一整行隐藏 + 行内组件，与代码围栏/分割线的处理保持一致。
  if (
    text.length >= 4 &&
    text.startsWith("$$") &&
    text.endsWith("$$") &&
    !selectionTouches(ctx.state, span.from, span.to)
  ) {
    const first = ctx.state.doc.line(span.firstLine);
    push(
      ctx,
      Decoration.replace({
        widget: new MathWidget(text.slice(2, -2).trim(), true, node.from),
      }),
      first.from,
      first.to,
    );
    push(ctx, Decoration.line({ class: "cm-lp-math-line" }), first.from, first.from);
    for (let number = span.firstLine + 1; number <= span.lastLine; number++) {
      collapseLine(ctx, number);
    }
    return;
  }

  for (const child of childrenOf(node)) buildInline(ctx, child);
}

function buildBlockquote(ctx: BuildContext, node: SyntaxNode) {
  // 续行的 `>` 会嵌套在 Paragraph 里，统一收集后按行判断是否展开
  const quoteMarks: SyntaxNode[] = [];
  const collect = (parent: SyntaxNode) => {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (child.name === "QuoteMark") {
        quoteMarks.push(child);
      } else if (child.name !== "FencedCode" && child.name !== "CodeBlock") {
        collect(child);
      }
    }
  };
  collect(node.node);

  for (const mark of quoteMarks) {
    const line = ctx.state.doc.lineAt(mark.from);
    if (selectionTouches(ctx.state, line.from, line.to)) continue;
    // `>` 与引用文字之间的空格一并隐藏，让文字与左边框对齐
    hideInline(ctx, mark.from, trailingSpaceEnd(ctx, mark.to));
  }

  const span = lineSpan(ctx.state, node.from, node.to);
  for (let number = span.firstLine; number <= span.lastLine; number++) {
    pushLine(ctx, ctx.state.doc.line(number).from, LINE_QUOTE);
  }

  for (const child of childrenOf(node)) {
    if (child.name === "QuoteMark") continue;
    buildBlock(ctx, child);
  }
}

function buildList(ctx: BuildContext, node: SyntaxNode) {
  const ordered = node.name === "OrderedList";
  for (const item of childrenOf(node)) {
    if (item.name === "ListItem") buildListItem(ctx, item, ordered);
  }
}

function buildListItem(ctx: BuildContext, item: SyntaxNode, ordered: boolean) {
  const mark = childOf(item, "ListMark");
  if (mark) {
    // 任务项前面已经有复选框，不再画圆点
    const isTask = childOf(item, "Task") !== null;
    if (ordered) {
      push(ctx, markOrderedMark, mark.from, mark.to);
    } else if (!isTask) {
      push(ctx, Decoration.replace({ widget: new BulletWidget() }), mark.from, mark.to);
    } else {
      hideInline(ctx, mark.from, trailingSpaceEnd(ctx, mark.to));
    }
  }

  for (const child of childrenOf(item)) {
    switch (child.name) {
      case "ListMark":
        break;
      case "Task":
        buildTask(ctx, child);
        break;
      case "Paragraph":
        buildParagraph(ctx, child);
        break;
      case "BulletList":
      case "OrderedList":
        buildList(ctx, child);
        break;
      case "Blockquote":
        buildBlockquote(ctx, child);
        break;
      case "FencedCode":
      case "CodeBlock":
        buildCodeBlock(ctx, child);
        break;
      case "Table":
        buildTable(ctx, child);
        break;
      default:
        buildInline(ctx, child);
        break;
    }
  }
}

function buildTask(ctx: BuildContext, node: SyntaxNode) {
  const marker = childOf(node, "TaskMarker");
  if (marker) {
    const source = ctx.state.doc.sliceString(marker.from, marker.to).toLowerCase();
    push(
      ctx,
      Decoration.replace({
        widget: new TaskWidget(source === "[x]", marker.from, ctx.options.onToggleTask),
      }),
      marker.from,
      marker.to,
    );
    hideInline(ctx, marker.to, trailingSpaceEnd(ctx, marker.to));
  }

  for (const child of childrenOf(node)) {
    if (child.name === "TaskMarker") continue;
    if (child.name === "Paragraph") buildParagraph(ctx, child);
    else buildInline(ctx, child);
  }
}

function buildCodeBlock(ctx: BuildContext, node: SyntaxNode) {
  const span = lineSpan(ctx.state, node.from, node.to);
  const reveal = selectionTouches(ctx.state, span.from, span.to);

  const fenceLines = new Set<number>();
  if (node.name === "FencedCode") {
    for (const child of childrenOf(node)) {
      if (child.name !== "CodeMark") continue;
      const line = ctx.state.doc.lineAt(child.from);
      const text = line.text.trimStart();
      if (text.startsWith("```") || text.startsWith("~~~")) fenceLines.add(line.number);
    }
  }

  if (!reveal) {
    for (const number of fenceLines) collapseLine(ctx, number);
  }

  // 首/末代码行单独标记，用来画圆角；中间行只铺背景
  let codeIndex = 0;
  let codeCount = 0;
  for (let number = span.firstLine; number <= span.lastLine; number++) {
    if (!reveal && fenceLines.has(number)) continue;
    codeCount++;
  }
  for (let number = span.firstLine; number <= span.lastLine; number++) {
    if (!reveal && fenceLines.has(number)) continue;
    codeIndex++;
    const className =
      codeCount === 1
        ? `${LINE_CODE} cm-lp-code-first cm-lp-code-last`
        : codeIndex === 1
          ? `${LINE_CODE} cm-lp-code-first`
          : codeIndex === codeCount
            ? `${LINE_CODE} cm-lp-code-last`
            : LINE_CODE;
    pushLine(ctx, ctx.state.doc.line(number).from, className);
  }

  for (const child of childrenOf(node)) {
    if (child.name === "CodeInfo") push(ctx, markCodeInfo, child.from, child.to);
    else if (child.name === "CodeText") push(ctx, markCodeText, child.from, child.to);
  }
}

function buildHorizontalRule(ctx: BuildContext, node: SyntaxNode) {
  const line = ctx.state.doc.lineAt(node.from);
  if (selectionTouches(ctx.state, line.from, line.to)) return;
  // 分隔线用一条 1px 的行样式呈现，原文 `---` 同时隐藏
  const key = `${line.from}:${LINE_RULE}`;
  if (!ctx.lines.has(key)) {
    ctx.lines.add(key);
    push(ctx, Decoration.line({ class: LINE_RULE }), line.from, line.from);
  }
  push(ctx, hide, line.from, line.to);
}

function buildTable(ctx: BuildContext, node: SyntaxNode) {
  const span = lineSpan(ctx.state, node.from, node.to);
  if (selectionTouches(ctx.state, span.from, span.to)) return;

  for (let number = span.firstLine; number <= span.lastLine; number++) {
    const line = ctx.state.doc.line(number);
    if (isTableDelimiterRow(line.text)) {
      collapseLine(ctx, number);
      continue;
    }
    pushLine(ctx, line.from, number === span.firstLine ? LINE_TABLE_HEADER : LINE_TABLE);
  }

  for (const child of childrenOf(node)) {
    if (child.name === "TableHeader") {
      buildTableRow(ctx, child);
    } else if (child.name === "TableRow") {
      buildTableRow(ctx, child);
    }
  }
}

function buildTableRow(ctx: BuildContext, row: SyntaxNode) {
  for (const cell of childrenOf(row)) {
    if (cell.name === "TableCell") {
      if (!isBlank(ctx.state.doc.sliceString(cell.from, cell.to))) {
        push(ctx, markTableCell, cell.from, cell.to);
      }
      buildInline(ctx, cell);
    } else if (cell.name === "TableDelimiter") {
      hideInline(ctx, cell.from, cell.to);
    }
  }
}

function isTableDelimiterRow(text: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(text) && text.includes("-");
}

/* ─────────────────────────── 组件 ─────────────────────────── */

class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly offset: number,
    readonly onToggle: ((offset: number, checked: boolean) => void) | undefined,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof TaskWidget &&
      other.checked === this.checked &&
      other.offset === this.offset &&
      other.onToggle === this.onToggle
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-lp-task";
    box.setAttribute("aria-label", this.checked ? "标记为未完成" : "标记为已完成");
    box.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.onToggle) {
        this.onToggle(this.offset, !this.checked);
        return;
      }
      const current = view.state.doc.sliceString(this.offset, this.offset + 1);
      view.dispatch({
        changes: { from: this.offset, to: this.offset + 1, insert: /x/i.test(current) ? " " : "x" },
      });
      view.focus();
    });
    return box;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    return other instanceof BulletWidget;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly offset: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof ImageWidget && other.src === this.src && other.alt === this.alt;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-lp-image";
    wrapper.title = this.alt;

    if (this.src) {
      const img = document.createElement("img");
      img.src = this.src;
      img.alt = this.alt;
      img.loading = "lazy";
      // 图片加载完成才知道真实高度，加载后补一次测量，避免后续行坐标偏移
      img.addEventListener("load", () => scheduleRemeasure(view), { once: true });
      wrapper.appendChild(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "cm-lp-image-placeholder";
      placeholder.textContent = this.alt || "image";
      wrapper.appendChild(placeholder);
    }

    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.offset } });
      view.focus();
    });
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly latex: string,
    readonly display: boolean,
    readonly offset: number,
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof MathWidget && other.latex === this.latex && other.display === this.display
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // 显示公式现在放在行内（不再是块级替换），用 span + block 样式渲染，
    // 避免块级组件参与行高测量时产生的累积误差
    const wrapper = document.createElement("span");
    wrapper.className = this.display ? "cm-lp-math-block" : "cm-lp-math";
    try {
      wrapper.innerHTML = katex.renderToString(this.latex, {
        displayMode: this.display,
        throwOnError: false,
        strict: "ignore",
        output: "html",
      });
    } catch {
      wrapper.textContent = this.latex;
    }
    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.offset } });
      view.focus();
    });
    // KaTeX 的字体会稍后才应用，行高在首帧会被量小，导致后续所有行坐标偏移。
    // 渲染尺寸稳定后主动请求一次重新测量。
    scheduleRemeasure(view);
    return wrapper;
  }

  get estimatedHeight(): number {
    return this.display ? 48 : -1;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/* ───────────────────── 渲染后重新测量 ───────────────────── */

/**
 * 行内组件（公式、图片）的首帧高度往往不是最终高度：KaTeX 的字体、
 * 图片的实际尺寸都要稍后才确定。CodeMirror 只在内容变化时重新测量行高，
 * 于是这些块会保留一个偏小的高度，并让**后面所有行**的点击坐标逐块偏移。
 *
 * 注意 requestMeasure() 只核对视口内已有的高度，不会重算高度表；
 * 必须把 mustMeasureContent 置为 "refresh" 才会整体重新测量。
 */
const pendingRemeasure = new WeakSet<EditorView>();

function scheduleRemeasure(view: EditorView) {
  if (pendingRemeasure.has(view)) return;
  pendingRemeasure.add(view);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!pendingRemeasure.delete(view) || !view.dom.isConnected) return;
      // viewState 是 CodeMirror 的内部对象（未在类型里公开）。
      // 只置 "refresh" 标记再 requestMeasure，做一次整体高度重算。
      const viewState = (view as unknown as { viewState?: { mustMeasureContent?: unknown } })
        .viewState;
      if (viewState) viewState.mustMeasureContent = "refresh";
      view.requestMeasure();
    });
  });
}

/* ─────────────────────── 围栏末尾的续写保护 ─────────────────────── */

/**
 * 闭合围栏在实时模式下会被折叠成 0 高度，点击代码块下方或按方向键往下时，
 * 光标很容易停在这一行的末尾。此时直接输入会把文字拼到 ` ``` ` 后面，
 * 围栏随之失效，后面的内容全被当成代码——用户会感觉"离不开代码框"。
 *
 * 这里在事务层面兜底：光标贴在闭合围栏行尾且有文字插入时，先补一个换行，
 * 让输入落到代码块外面。粘贴多行内容同理。
 */
function isClosingFenceTail(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  if (pos !== line.to) return false;
  if (!/^(`{3,}|~{3,})$/.test(line.text.trim())) return false;

  // 刚敲完围栏时语法树可能还没解析到这一行，按需补一次同步解析
  const tree = syntaxTreeAvailable(state, pos)
    ? syntaxTree(state)
    : ensureSyntaxTree(state, pos, 20);
  if (!tree) return false;

  const node = tree.resolveInner(Math.max(0, pos - 1), -1);
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (current.name !== "FencedCode") continue;
    // 必须真的存在闭合围栏：只有开头那一个 CodeMark 时不算
    const marks: SyntaxNode[] = [];
    for (const child of childrenOf(current)) {
      if (child.name === "CodeMark") marks.push(child);
    }
    if (marks.length < 2) return false;
    return marks[marks.length - 1].from === line.from;
  }
  return false;
}

const fenceExitFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.startState.readOnly) return tr;

  const state = tr.startState;
  const changes: Array<{ from: number; insert: string }> = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (toA !== fromA || inserted.length === 0) return;
    // 换行开头的内容本身就在下一行，不用再补
    if (inserted.toString().startsWith(state.lineBreak)) return;
    if (!isClosingFenceTail(state, fromA)) return;
    changes.push({ from: fromA, insert: state.lineBreak + inserted.toString() });
  });
  if (changes.length === 0) return tr;

  // 多出来的只是一个换行，光标整体后移，继续输入不会掉回围栏行
  const extra = state.lineBreak.length;
  const selection = EditorSelection.create(
    tr.newSelection.ranges.map((range) => {
      const shift = changes.reduce(
        (sum, change) => (change.from <= range.head ? sum + extra : sum),
        0,
      );
      return EditorSelection.range(range.anchor + shift, range.head + shift, range.goalColumn);
    }),
    tr.newSelection.mainIndex,
  );

  const annotations: Annotation<any>[] = [
    Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? "input.type"),
    Transaction.time.of(tr.annotation(Transaction.time) ?? Date.now()),
  ];
  const addToHistory = tr.annotation(Transaction.addToHistory);
  if (addToHistory !== undefined) {
    annotations.push(Transaction.addToHistory.of(addToHistory));
  }

  return {
    changes,
    selection,
    effects: tr.effects,
    annotations,
    scrollIntoView: tr.scrollIntoView,
  };
});

/* ───────────────────── 未闭合围栏的退出 ───────────────────── */

/**
 * 用户敲出 ` ```js ` 之后往往不会再手写收尾围栏。按 Markdown 语法，
 * 未闭合的围栏一直延伸到文件末尾，于是后面所有输入都被当成代码，
 * 光标只能在代码块里打转——表现就是"下方没法继续编辑"。
 *
 * 沿用飞书/Notion 的习惯：在代码块末尾的空行上再按一次回车（即连按两次回车），
 * 或者点击代码块下方的空白，就自动补上收尾围栏并把光标放到块外。
 * 代码块内部的普通换行不受影响。
 */

/** 光标位置所在的未闭合围栏；不在未闭合围栏里时返回 null */
function unclosedFenceAt(state: EditorState, pos: number): SyntaxNode | null {
  const tree = syntaxTreeAvailable(state, pos)
    ? syntaxTree(state)
    : ensureSyntaxTree(state, pos, 20);
  if (!tree) return null;
  const node = tree.resolveInner(Math.max(0, Math.min(pos, state.doc.length)), -1);
  for (let current: SyntaxNode | null = node; current; current = current.parent) {
    if (current.name !== "FencedCode") continue;
    let codeMarks = 0;
    for (const child of childrenOf(current)) {
      if (child.name === "CodeMark") codeMarks++;
    }
    return codeMarks < 2 ? current : null;
  }
  return null;
}

/**
 * 在文档末尾补上收尾围栏（沿用开头围栏的字符与长度）。
 * 末尾若正好是一个空行，就把这个空行改写成围栏行，不留多余空行。
 * 不在未闭合围栏内时返回 null。
 */
export function fenceExitChange(state: EditorState): { from: number; insert: string } | null {
  const fence = unclosedFenceAt(state, state.doc.length);
  if (!fence) return null;

  let marker = "```";
  for (const child of childrenOf(fence)) {
    if (child.name === "CodeMark") {
      marker = state.doc.sliceString(child.from, child.to);
      break;
    }
  }

  const lastLine = state.doc.line(state.doc.lines);
  const reuseEmptyLine = lastLine.length === 0 && state.doc.length > 0;
  return {
    from: reuseEmptyLine ? lastLine.from : state.doc.length,
    insert: `${reuseEmptyLine ? "" : "\n"}${marker}\n`,
  };
}

function closeFence(view: EditorView): boolean {
  const change = fenceExitChange(view.state);
  if (!change) return false;
  view.dispatch({
    changes: change,
    selection: EditorSelection.cursor(change.from + change.insert.length),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}

/** 只在"最后一行"上接管按键，代码块内部的普通编辑不受影响 */
function onExitKey(view: EditorView, requireEmptyLine: boolean): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  if (line.number !== state.doc.lines) return false;
  if (requireEmptyLine && line.length !== 0) return false;
  return closeFence(view);
}

/**
 * 点击内容区末尾下方的空白：未闭合围栏会一直占到文件末尾，
 * 默认行为只会把光标放回最后一行代码，所以这里显式收尾。
 */
const fenceClickHandler = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    if (event.button !== 0 || view.state.readOnly) return false;
    if (!unclosedFenceAt(view.state, view.state.doc.length)) return false;
    const endCoords = view.coordsAtPos(view.state.doc.length);
    if (!endCoords || event.clientY <= endCoords.bottom) return false;

    // 先确认真的补上了围栏，再阻止默认的选区行为
    if (!closeFence(view)) return false;
    event.preventDefault();
    view.focus();
    return true;
  },
});

/**
 * 只接管末尾空行上的回车：连按两次回车即可离开代码块。
 * 不接管 ↓，避免破坏正常的光标上下移动。
 */
const fenceExitKeymap = Prec.highest(
  keymap.of([{ key: "Enter", run: (view) => onExitKey(view, true) }]),
);

/* ─────────────────────────── 入口 ─────────────────────────── */

export function buildLivePreviewDecorations(
  state: EditorState,
  options: LivePreviewOptions,
): DecorationSet {
  const ctx: BuildContext = {
    state,
    options,
    ranges: [],
    replacedLines: new Set(),
    lines: new Set(),
  };

  buildBlock(ctx, syntaxTree(state).topNode);

  return Decoration.set(ctx.ranges, true);
}

const livePreviewField = StateField.define<DecorationSet>({
  create(state) {
    return buildLivePreviewDecorations(state, state.facet(optionsFacet));
  },
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && tr.effects.length === 0) return value;
    return buildLivePreviewDecorations(tr.state, tr.state.facet(optionsFacet));
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** 焦点变化不产生事务，用 DOM 事件显式触发一次装饰重算 */
const focusHandlers = EditorView.domEventHandlers({
  focus: (_event, view) => {
    if (!view.state.field(editorActiveField)) {
      view.dispatch({ effects: setEditorActive.of(true) });
    }
    return false;
  },
  blur: (_event, view) => {
    if (view.state.field(editorActiveField)) {
      view.dispatch({ effects: setEditorActive.of(false) });
    }
    return false;
  },
});

const livePreviewTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "transparent",
    fontSize: "inherit",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-body)",
    lineHeight: "1.9",
    overflowX: "hidden",
  },
  ".cm-content": {
    padding: "2px 0 40px",
    color: "var(--color-ink-soft)",
    caretColor: "var(--color-bamboo)",
    minHeight: "100%",
  },
  ".cm-line": { padding: "0 0 0 2px" },
  ".cm-placeholder": { color: "var(--color-ink-ghost)" },
  ".cm-cursor": { borderLeftColor: "var(--color-bamboo)" },
});

export function livePreviewExtension(options: LivePreviewOptions = {}): Extension {
  return [
    optionsFacet.of(options),
    // 放在装饰字段之前，保证同一事务里装饰读到最新的焦点状态
    editorActiveField,
    focusHandlers,
    fenceExitFilter,
    fenceClickHandler,
    fenceExitKeymap,
    livePreviewField,
    livePreviewTheme,
    EditorView.lineWrapping,
  ];
}
