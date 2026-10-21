import { describe, expect, test } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import {
  buildLivePreviewDecorations,
  fenceExitChange,
  livePreviewExtension,
  setEditorActive,
} from "./livePreview";
import { livePreviewMarkdown } from "./livePreviewLanguage";

/**
 * 这些用例直接读取装饰集合：block 替换表示"整行语法被隐藏"，
 * mark 装饰表示"套上了排版样式"，两者共同构成 Live Preview 的观感。
 */
function analyze(doc: string, cursor: number | null = null) {
  const state = EditorState.create({
    doc,
    // 默认把光标放到文末，避免"光标所在行展开源码"干扰断言
    selection: EditorSelection.cursor(cursor ?? doc.length),
    extensions: [livePreviewMarkdown],
  });
  // 解析是增量进行的，测试里确保整篇解析完成
  ensureSyntaxTree(state, doc.length, 1000);
  const set = buildLivePreviewDecorations(state, {});

  const hidden: Array<[number, number]> = [];
  const lines: string[] = [];
  const marks: string[] = [];
  const widgets: string[] = [];

  const iter = set.iter();
  while (iter.value) {
    const spec = iter.value.spec as Record<string, unknown>;
    const className = typeof spec.class === "string" ? spec.class : "";
    const widgetName = spec.widget
      ? (spec.widget as { constructor: { name: string } }).constructor.name
      : "";

    if (iter.value.point) {
      if (className) {
        // line 装饰：零长度区间 + class
        lines.push(className);
        iter.next();
        continue;
      }
      // 其余 point 装饰都是替换：隐藏标记或占位组件
      hidden.push([iter.from, iter.to]);
      if (widgetName) widgets.push(widgetName);
    } else if (className) {
      marks.push(className);
    }

    iter.next();
  }

  return { hidden, lines, marks, widgets };
}

describe("live preview decorations", () => {
  test("hides ATX heading markers and applies the heading line class", () => {
    const { hidden, lines } = analyze("# 标题\n\n正文\n\n结束");

    // `#` 与它后面的空格一并隐藏
    expect(hidden).toEqual([[0, 2]]);
    expect(lines.some((cls) => cls.includes("cm-lp-h1"))).toBe(true);
  });

  test("reveals heading markers while the cursor sits on that line", () => {
    const { hidden } = analyze("# 标题\n\n正文", 3);

    expect(hidden).toEqual([]);
  });

  test("hides emphasis markers and marks the text bold", () => {
    const { hidden, marks } = analyze("这是**粗体**文字\n\n另一段");

    expect(hidden).toEqual([
      [2, 4],
      [6, 8],
    ]);
    expect(marks).toContain("cm-lp-strong");
  });

  test("reveals emphasis markers when the cursor is inside the node", () => {
    const { hidden } = analyze("这是**粗体**文字\n\n另一段", 3);

    expect(hidden).toEqual([]);
  });

  test("renders bullet list markers as a bullet widget", () => {
    const { widgets, marks } = analyze("- 一\n- 二\n\n结束");

    expect(widgets.filter((name) => name === "BulletWidget")).toHaveLength(2);
    expect(marks).not.toContain("cm-lp-ordered-mark");
  });

  test("keeps ordered list numbers visible", () => {
    const { marks, widgets } = analyze("1. 一\n2. 二\n\n结束");

    expect(marks.filter((cls) => cls === "cm-lp-ordered-mark")).toHaveLength(2);
    expect(widgets).toHaveLength(0);
  });

  test("collapses fenced code fences and styling the code lines", () => {
    const { hidden, lines } = analyze("```js\nconst a = 1;\n```\n\n结束");

    // 两条围栏行被折叠：零高度行样式 + 行内文本隐藏
    expect(lines.filter((cls) => cls === "cm-lp-collapsed-line")).toHaveLength(2);
    expect(hidden).toHaveLength(2);
    expect(lines.some((cls) => cls.includes("cm-lp-code-line"))).toBe(true);
  });

  test("shows fenced code markers while editing inside the block", () => {
    const doc = "```js\nconst a = 1;\n```";
    const { hidden } = analyze(doc, doc.indexOf("const"));

    expect(hidden).toHaveLength(0);
  });

  /**
   * 闭合围栏被折叠成 0 高度后，光标很容易停在它行尾。若此时输入的文字直接
   * 拼到围栏后面，围栏就失效了，后面所有内容都会被吞进代码块。
   * 兜底行为：先在围栏前补一个换行，让新内容落到代码块外面。
   */
  describe("typing at the end of a closing fence", () => {
    const doc = "```js\nconst a = 1;\n```";

    function typeAt(docText: string, pos: number, insert: string) {
      const state = EditorState.create({
        doc: docText,
        selection: EditorSelection.cursor(pos),
        extensions: [livePreviewMarkdown, livePreviewExtension()],
      });
      ensureSyntaxTree(state, docText.length, 1000);
      const next = state.update({ changes: { from: pos, insert }, userEvent: "input.type" }).state;
      return next.doc.toString();
    }

    test("moves typing outside the block instead of extending the fence", () => {
      const typed = typeAt(doc, doc.length, "新段落");

      expect(typed).toBe("```js\nconst a = 1;\n```\n新段落");
    });

    test("keeps the closing fence intact for multi-line pastes", () => {
      const typed = typeAt(doc, doc.length, "第一行\n第二行");

      expect(typed).toBe("```js\nconst a = 1;\n```\n第一行\n第二行");
    });

    test("leaves an existing trailing newline alone", () => {
      const withNewline = `${doc}\n`;
      const typed = typeAt(withNewline, withNewline.length, "正文");

      expect(typed).toBe("```js\nconst a = 1;\n```\n正文");
    });

    test("does not interfere with typing inside the code body", () => {
      const bodyPos = doc.indexOf("const a = 1;") + "const a = 1;".length;
      const typed = typeAt(doc, bodyPos, " // 注释");

      expect(typed).toBe("```js\nconst a = 1; // 注释\n```");
    });

    test("does not interfere with typing after the opening fence only", () => {
      // 只有开围栏：后面输入的内容本来就属于代码
      const openOnly = "```js";
      const typed = typeAt(openOnly, openOnly.length, "\nconst a = 1;");

      expect(typed).toBe("```js\nconst a = 1;");
    });
  });

  /**
   * 用户写完 ```js 后通常不会手写收尾围栏，未闭合的围栏会一直延伸到文件末尾，
   * 后面所有输入都被当成代码——这正是"下方没法继续编辑"的来源。
   * 这里验证自动收尾的变更内容（快捷键与点击都走同一个函数）。
   */
  describe("closing an unclosed fence", () => {
    function exitChange(docText: string) {
      const state = EditorState.create({
        doc: docText,
        selection: EditorSelection.cursor(docText.length),
        extensions: [livePreviewMarkdown, livePreviewExtension()],
      });
      ensureSyntaxTree(state, docText.length, 1000);
      return { change: fenceExitChange(state), state };
    }

    test("appends a fence when the block ends without a trailing newline", () => {
      const { change } = exitChange("```js\nconst a = 1;");

      expect(change).toEqual({ from: 18, insert: "\n```\n" });
    });

    test("reuses the trailing empty line instead of adding a blank one", () => {
      const { change } = exitChange("```js\nconst a = 1;\n");

      expect(change).toEqual({ from: 19, insert: "```\n" });
    });

    test("mirrors the opening fence marker and length", () => {
      const { change } = exitChange("~~~js\nconst a = 1;");

      expect(change?.insert).toBe("\n~~~\n");
    });

    test("does nothing for a fence that is already closed", () => {
      const { change } = exitChange("```js\nconst a = 1;\n```");

      expect(change).toBeNull();
    });

    test("does nothing for plain paragraphs", () => {
      const { change } = exitChange("普通段落\n\n第二段");

      expect(change).toBeNull();
    });
  });

  test("renders task list checkboxes and reports the checked state", () => {
    const { widgets } = analyze("- [ ] 待办\n- [x] 完成\n\n结束");

    expect(widgets.filter((name) => name === "TaskWidget")).toHaveLength(2);
  });

  test("hides link syntax and keeps the label styled", () => {
    const { hidden, marks } = analyze("[花笺](https://example.com)\n\n结束");

    expect(hidden.length).toBeGreaterThan(0);
    expect(marks).toContain("cm-lp-link");
  });

  test("turns images into widgets", () => {
    const { widgets } = analyze("![图注](images/a.png)\n\n结束");

    expect(widgets).toContain("ImageWidget");
  });

  test("renders standalone display math as a block widget", () => {
    const { widgets } = analyze("$$\nx^2 + y^2 = r^2\n$$\n\n结束");

    expect(widgets).toContain("MathWidget");
  });

  test("renders inline math with dollar markers hidden", () => {
    const { hidden, widgets } = analyze("能量 $E=mc^2$ 公式\n\n结束");

    expect(widgets).toContain("MathWidget");
    // 整个 `$E=mc^2$` 被替换成一个公式组件
    expect(hidden).toEqual([[3, 11]]);
  });

  test("hides the table delimiter row and keeps cell text", () => {
    const { hidden, lines } = analyze("| 名称 | 值 |\n| --- | --- |\n| 甲 | 1 |\n\n结束");

    // 分隔行折叠；两行数据各 3 个 `|` 行内隐藏，加上折叠行自身的文本隐藏
    expect(lines.filter((cls) => cls === "cm-lp-collapsed-line")).toHaveLength(1);
    expect(hidden).toHaveLength(7);
    expect(lines.some((cls) => cls.includes("cm-lp-table-header"))).toBe(true);
  });

  test("renders a horizontal rule as a styled line", () => {
    const { hidden, lines } = analyze("上文\n\n---\n\n下文");

    expect(lines).toContain("cm-lp-hr-line");
    expect(hidden).toHaveLength(1);
  });

  test("keeps text untouched inside inline code", () => {
    const { hidden, marks } = analyze("使用 `**不是粗体**` 标记\n\n结束");

    // 只隐藏两侧反引号，内部的 ** 保持原样
    expect(hidden).toEqual([
      [3, 4],
      [12, 13],
    ]);
    expect(marks).toContain("cm-lp-inline-code");
    expect(marks).not.toContain("cm-lp-strong");
  });

  test("renders everything once the editor loses focus", () => {
    const doc = "# 标题\n\n正文\n\n结束";
    const base = EditorState.create({
      doc,
      selection: EditorSelection.cursor(1),
      extensions: [livePreviewMarkdown, livePreviewExtension()],
    });
    ensureSyntaxTree(base, doc.length, 1000);

    const countHidden = (state: EditorState) => {
      let count = 0;
      const iter = buildLivePreviewDecorations(state, {}).iter();
      while (iter.value) {
        if (iter.value.point && !(iter.value.spec as { class?: string }).class) count++;
        iter.next();
      }
      return count;
    };

    // 有焦点：光标在标题行 → 源码展开，`#` 不隐藏
    expect(countHidden(base)).toBe(0);

    // 失焦：整篇按渲染后的样子显示
    const blurred = base.update({ effects: setEditorActive.of(false) }).state;
    expect(countHidden(blurred)).toBeGreaterThan(0);
  });

  test("produces consistent decorations for plain paragraphs", () => {
    const { hidden, marks, widgets } = analyze("一段普通的文字。\n\n结束");

    expect(hidden).toEqual([]);
    expect(marks).toEqual([]);
    expect(widgets).toEqual([]);
  });
});
