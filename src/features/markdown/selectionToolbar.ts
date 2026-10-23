import type { TFunction } from "i18next";
import type { EditorState, Extension } from "@codemirror/state";
import { Prec, StateField } from "@codemirror/state";
import type { EditorView, Tooltip, TooltipView } from "@codemirror/view";
import { EditorView as View, keymap, showTooltip } from "@codemirror/view";
import { applyMarkdownFormat, type MarkdownFormatAction } from "./formatMarkdown";
import { SELECTION_FORMAT_ACTIONS, SELECTION_SHORTCUTS } from "./selectionActions";

/**
 * 选中文字后浮出的小工具条。
 *
 * 目的是让"改格式"不再需要先记住语法：选中一句话，点一下 B 就变成
 * `**这句话**`，而且选区保持不变，可以连续叠加多种格式。
 *
 * 只处理单段非空选区；多光标与全选不弹，避免遮挡大段文字。
 */

interface SelectionRange {
  from: number;
  to: number;
}

const selectionField = StateField.define<SelectionRange | null>({
  create: (state) => selectionRange(state),
  update(value, tr) {
    if (!tr.selection && !tr.docChanged) return value;
    return selectionRange(tr.state);
  },
});

function selectionRange(state: EditorState): SelectionRange | null {
  if (state.readOnly) return null;
  const range = state.selection.main;
  if (range.empty) return null;
  // 跨行的长选区不弹，浮条会遮住正文
  if (state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number) return null;
  return { from: range.from, to: range.to };
}

const toolbarTooltip = (getTranslate: () => TFunction): Tooltip => ({
  // 位置由 ToolbarView.getCoords 按选区实时给出，pos 只是占位
  pos: 0,
  above: true,
  // 选区在视口内即可，不必让 CodeMirror 用 pos 0 判断可见性
  clip: false,
  create: (view) => new ToolbarView(view, getTranslate),
});

class ToolbarView implements TooltipView {
  readonly dom: HTMLElement;
  private readonly view: EditorView;
  private readonly getTranslate: () => TFunction;

  constructor(view: EditorView, getTranslate: () => TFunction) {
    this.view = view;
    this.getTranslate = getTranslate;
    this.dom = document.createElement("div");
    this.dom.className = "lp-selection-toolbar";
    this.dom.setAttribute("role", "toolbar");
    this.render();
  }

  update(): void {
    this.render();
  }

  /** 浮条左端与选区左端对齐；选区在视口外时退回编辑器顶部 */
  getCoords(): { left: number; right: number; top: number; bottom: number } {
    const range = this.view.state.field(selectionField, false);
    const coords = range ? this.view.coordsAtPos(range.from) : null;
    if (coords) return coords;

    const editor = this.view.dom.getBoundingClientRect();
    return { left: editor.left, right: editor.left, top: editor.top, bottom: editor.top };
  }

  private render() {
    const t = this.getTranslate();
    this.dom.replaceChildren(
      ...SELECTION_FORMAT_ACTIONS.map((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.title = t(item.titleKey, { defaultValue: item.defaultTitle });
        button.setAttribute("aria-label", button.title);
        button.className = `lp-selection-toolbar-button ${item.className ?? ""}`;
        if (item.svg) button.innerHTML = item.svg;
        else button.textContent = item.glyph ?? "";

        // 按下时不让编辑器失焦，否则选区会收起、浮条跟着消失
        button.addEventListener("mousedown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        button.addEventListener("click", (event) => {
          event.preventDefault();
          applyFormatToView(this.view, item.action, this.getTranslate());
        });
        return button;
      }),
    );
  }
}

/** 对主选区应用一次格式化，并保持选区（方便连续叠加格式） */
export function applyFormatToView(
  view: EditorView,
  action: MarkdownFormatAction,
  translate: TFunction,
): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  const result = applyMarkdownFormat(view.state.doc.toString(), from, to, action, translate);
  if (result.value === view.state.doc.toString()) return false;

  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: result.value },
    selection: { anchor: result.selectionStart, head: result.selectionEnd },
    scrollIntoView: true,
    userEvent: "input.format",
  });
  view.focus();
  return true;
}

export function selectionToolbarExtension(getTranslate: () => TFunction): Extension {
  return [
    selectionField,
    showTooltip.computeN([selectionField], (state) =>
      state.field(selectionField) ? [toolbarTooltip(getTranslate)] : [],
    ),
    // 快捷键优先于 defaultKeymap：Mod-i 默认是「选中父级语法」，Mod-k 未被占用
    Prec.high(
      keymap.of(
        SELECTION_SHORTCUTS.map(({ key, action }) => ({
          key,
          run: (view: EditorView) => applyFormatToView(view, action, getTranslate()),
        })),
      ),
    ),
    View.theme({
      ".lp-selection-toolbar": {
        display: "flex",
        alignItems: "center",
        gap: "1px",
        padding: "3px",
        background: "var(--color-paper)",
        border: "1px solid color-mix(in srgb, var(--color-paper-deep) 85%, transparent)",
        borderRadius: "8px",
        boxShadow: "0 6px 18px -6px var(--color-shadow-deep), 0 1px 3px -1px var(--color-shadow)",
        userSelect: "none",
      },
      ".lp-selection-toolbar-button": {
        width: "24px",
        height: "24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0",
        border: "none",
        background: "transparent",
        borderRadius: "5px",
        color: "var(--color-ink-faint)",
        fontSize: "12px",
        lineHeight: "1",
        cursor: "pointer",
        transition: "background-color .12s, color .12s",
      },
      ".lp-selection-toolbar-button:hover": {
        background: "var(--color-bamboo-mist)",
        color: "var(--color-bamboo)",
      },
    }),
  ];
}
