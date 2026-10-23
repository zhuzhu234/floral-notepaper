import type { MarkdownFormatAction } from "./formatMarkdown";

/**
 * 「选中即改」浮条里的动作。
 *
 * CodeMirror 的浮条用原生 DOM 渲染，textarea 用 React 渲染，
 * 两边共用这份定义与同一套 CSS，避免出现"两种模式按钮不一样"的割裂感。
 */
export interface SelectionFormatAction {
  action: MarkdownFormatAction;
  /** i18n key 与兜底文案 */
  titleKey: string;
  defaultTitle: string;
  /** 文本字形（与工具栏按钮保持一致的视觉语言） */
  glyph?: string;
  /** 内联 SVG（链接这类没有合适字形的动作用图标） */
  svg?: string;
  /** 额外样式，比如删除线的横穿效果 */
  className?: string;
}

const LINK_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

export const SELECTION_FORMAT_ACTIONS: readonly SelectionFormatAction[] = [
  {
    action: "bold",
    titleKey: "main.toolbar.bold",
    defaultTitle: "粗体",
    glyph: "B",
    className: "font-bold",
  },
  {
    action: "italic",
    titleKey: "main.toolbar.italic",
    defaultTitle: "斜体",
    glyph: "I",
    className: "italic",
  },
  {
    action: "strike",
    titleKey: "main.toolbar.strike",
    defaultTitle: "删除线",
    glyph: "S",
    className: "line-through",
  },
  {
    action: "code",
    titleKey: "main.toolbar.code",
    defaultTitle: "代码",
    glyph: "<>",
    className: "font-mono text-[10px]",
  },
  {
    action: "link",
    titleKey: "main.toolbar.link",
    defaultTitle: "链接",
    svg: LINK_SVG,
  },
];

/** 浮条与快捷键共用的动作映射：Mod+B / Mod+I / Mod+Shift+X / Mod+E / Mod+K */
export const SELECTION_SHORTCUTS: ReadonlyArray<{ key: string; action: MarkdownFormatAction }> = [
  { key: "Mod-b", action: "bold" },
  { key: "Mod-i", action: "italic" },
  { key: "Mod-Shift-x", action: "strike" },
  { key: "Mod-e", action: "code" },
  { key: "Mod-k", action: "link" },
];
