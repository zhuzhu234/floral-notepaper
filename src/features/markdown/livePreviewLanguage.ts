import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import type { InlineContext, MarkdownConfig } from "@lezer/markdown";

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;
const SPACE = 0x20;
const TAB = 0x09;
const NEWLINE = 0x0a;

/**
 * `$...$` 行内公式。与 remark-math 的常见约束保持一致：
 * 开头 `$` 后不能是空白，结尾 `$` 前不能是空白，且不跨行。
 * `$$` 交给块级公式处理，因此这里遇到连续两个 `$` 直接放弃。
 */
const inlineMath: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }, { name: "MathMark" }],
  parseInline: [
    {
      name: "InlineMath",
      before: "Emphasis",
      parse(cx: InlineContext, next: number, pos: number): number {
        if (next !== DOLLAR) return -1;
        if (cx.char(pos + 1) === DOLLAR) return -1;

        const end = cx.end;
        if (pos + 2 >= end) return -1;

        const first = cx.char(pos + 1);
        if (first === SPACE || first === TAB || first === NEWLINE) return -1;

        for (let i = pos + 2; i < end; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE) return -1;
          if (ch === BACKSLASH) {
            i++;
            continue;
          }
          if (ch !== DOLLAR) continue;

          const prev = cx.char(i - 1);
          if (prev === SPACE || prev === TAB) return -1;
          if (!cx.slice(pos + 1, i).trim()) return -1;

          return cx.addElement(
            cx.elt("InlineMath", pos, i + 1, [
              cx.elt("MathMark", pos, pos + 1),
              cx.elt("MathMark", i, i + 1),
            ]),
          );
        }

        return -1;
      },
    },
  ],
};

export const livePreviewMarkdown = markdown({
  extensions: [GFM, inlineMath],
  completeHTMLTags: false,
  pasteURLAsLink: false,
});
