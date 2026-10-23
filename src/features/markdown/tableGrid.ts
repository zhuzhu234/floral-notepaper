import type { TFunction } from "i18next";
import type { EditorState, Extension } from "@codemirror/state";
import { Prec, StateEffect, StateField } from "@codemirror/state";
import type { EditorView, Rect, Tooltip, TooltipView } from "@codemirror/view";
import { EditorView as View, keymap, showTooltip } from "@codemirror/view";
import { closeCompletion } from "@codemirror/autocomplete";
import { applyBlockCommand, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "./blockCommands";

/**
 * 表格网格选择器。
 *
 * 斜杠菜单里选「表格」后不直接插入，而是先弹出 8×8 的网格：悬停预览、
 * 拖选或方向键调整，确认后才落笔。表格最常见的麻烦是插错了再手动删列，
 * 多花一次点击就能省掉后面的返工。
 *
 * 网格期间 `/表格` 仍留在文档里，确认时交给 applyBlockCommand 整行替换，
 * 缩进、正文保留与「一步撤销」都和斜杠菜单其他命令保持一致。
 */

export interface TableGridState {
  /** `/查询` 区间，取消时据此回删 */
  from: number;
  to: number;
  /** 气泡锚点（`/查询` 末尾） */
  anchor: number;
  columns: number;
  rows: number;
}

const openTableGrid = StateEffect.define<TableGridState>();
const closeTableGrid = StateEffect.define<null>();

const tableGridField = StateField.define<TableGridState | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(openTableGrid)) return effect.value;
      if (effect.is(closeTableGrid)) return null;
    }
    // 用户改动了文档说明已经离开这次插入；单选区的移动不算离开，
    // 否则点正文时会留下一个无意义的 `/查询`
    if (tr.docChanged) return null;
    return value;
  },
});

/** 斜杠菜单选中「表格」后进入网格步骤，先关掉补全气泡 */
export function startTableGrid(view: EditorView, from: number, to: number): void {
  closeCompletion(view);
  view.dispatch({
    effects: openTableGrid.of({ from, to, anchor: to, columns: 2, rows: 2 }),
  });
}

/**
 * 设置网格尺寸（悬停与方向键共用）。
 * 网格没开时返回 false，把按键让给编辑器。
 */
export function setTableGridSize(view: EditorView, columns: number, rows: number): boolean {
  const state = view.state.field(tableGridField, false);
  if (!state) return false;

  const nextColumns = Math.max(1, Math.min(TABLE_MAX_COLUMNS, columns));
  const nextRows = Math.max(1, Math.min(TABLE_MAX_ROWS, rows));
  if (nextColumns === state.columns && nextRows === state.rows) return true;

  view.dispatch({
    effects: openTableGrid.of({ ...state, columns: nextColumns, rows: nextRows }),
  });
  return true;
}

/** 方向键调整尺寸，到边界后停住而不是回绕 */
export function stepTableGrid(view: EditorView, deltaColumns: number, deltaRows: number): boolean {
  const state = view.state.field(tableGridField, false);
  if (!state) return false;
  return setTableGridSize(view, state.columns + deltaColumns, state.rows + deltaRows);
}

/** 按当前尺寸插入表格，并选中第一个表头占位符 */
export function confirmTableGrid(view: EditorView, translate: TFunction): boolean {
  const state = view.state.field(tableGridField, false);
  if (!state) return false;

  const result = applyBlockCommand(
    view.state.doc.toString(),
    state.from,
    state.to,
    "table",
    translate,
    { tableSize: { columns: state.columns, rows: state.rows } },
  );
  if (!result) return false;

  view.dispatch({
    changes: result.change,
    selection: { anchor: result.anchor, head: result.head },
    effects: closeTableGrid.of(null),
    scrollIntoView: true,
    userEvent: "input.complete",
  });
  view.focus();
  return true;
}

/** 取消插入：收起网格并回删 `/查询`，不留下无意义的斜杠 */
export function cancelTableGrid(view: EditorView, options: { focus?: boolean } = {}): boolean {
  const state = view.state.field(tableGridField, false);
  if (!state) return false;

  view.dispatch({
    changes: { from: state.from, to: state.to },
    selection: { anchor: state.from },
    effects: closeTableGrid.of(null),
    userEvent: "delete",
  });
  // 因失焦而取消时不要把焦点抢回来，否则点侧栏会变成点不出去
  if (options.focus !== false) view.focus();
  return true;
}

/** 供测试与斜杠菜单判断网格是否打开 */
export function tableGridSize(state: EditorState): { columns: number; rows: number } | null {
  const value = state.field(tableGridField, false);
  return value ? { columns: value.columns, rows: value.rows } : null;
}

class GridView implements TooltipView {
  readonly dom: HTMLElement;
  private readonly view: EditorView;
  private readonly getTranslate: () => TFunction;
  private readonly cells: HTMLButtonElement[] = [];
  private readonly label: HTMLElement;
  /** 鼠标是否按下：按下后拖动只预览，松开才确认 */
  private dragging = false;
  /** 松开的位置在网格外时不算确认，避免拖出去误插 */
  private readonly handleMouseUp = (event: MouseEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    if (event.target instanceof Node && this.dom.contains(event.target)) this.confirm();
  };

  constructor(view: EditorView, getTranslate: () => TFunction) {
    this.view = view;
    this.getTranslate = getTranslate;
    this.dom = document.createElement("div");
    this.dom.className = "lp-table-grid";
    this.dom.setAttribute("role", "group");

    const grid = document.createElement("div");
    grid.className = "lp-table-grid-cells";
    for (let row = 1; row <= TABLE_MAX_ROWS; row++) {
      for (let column = 1; column <= TABLE_MAX_COLUMNS; column++) {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "lp-table-grid-cell";
        cell.setAttribute("aria-label", `${column} × ${row}`);
        cell.addEventListener("mousedown", (event) => {
          // 不让点击把焦点从编辑器抢走
          event.preventDefault();
          event.stopPropagation();
          this.dragging = true;
          setTableGridSize(this.view, column, row);
        });
        cell.addEventListener("mouseenter", () => setTableGridSize(this.view, column, row));
        // 键盘（回车/空格）触发的 click 没有鼠标细节，直接确认
        cell.addEventListener("click", (event) => {
          event.preventDefault();
          if (event.detail === 0) this.confirm(column, row);
        });
        this.cells.push(cell);
        grid.appendChild(cell);
      }
    }

    this.label = document.createElement("div");
    this.label.className = "lp-table-grid-label";
    this.dom.replaceChildren(grid, this.label);
    this.dom.setAttribute(
      "aria-label",
      getTranslate()("main.slash.table.pick", { defaultValue: "选择表格尺寸" }),
    );
    window.addEventListener("mouseup", this.handleMouseUp);
    this.sync();
  }

  update(): void {
    this.sync();
  }

  destroy(): void {
    window.removeEventListener("mouseup", this.handleMouseUp);
  }

  /** 气泡定位在 `/查询` 末尾下方 */
  getCoords(): Rect {
    const state = this.view.state.field(tableGridField, false);
    const coords = state ? this.view.coordsAtPos(state.anchor) : null;
    if (coords) return coords;

    const editor = this.view.dom.getBoundingClientRect();
    return { left: editor.left, right: editor.left, top: editor.top, bottom: editor.top };
  }

  /** 只改高亮与文字，重建 DOM 会让悬停中的格子丢失鼠标事件 */
  private sync() {
    const state = this.view.state.field(tableGridField, false);
    if (!state) return;

    this.cells.forEach((cell, index) => {
      const row = Math.floor(index / TABLE_MAX_COLUMNS) + 1;
      const column = (index % TABLE_MAX_COLUMNS) + 1;
      cell.dataset.active = String(column <= state.columns && row <= state.rows);
    });

    this.label.textContent = this.getTranslate()("main.slash.table.size", {
      columns: state.columns,
      rows: state.rows,
      defaultValue: "{{columns}} 列 × {{rows}} 行",
    });
  }

  private confirm(columns?: number, rows?: number) {
    if (columns != null && rows != null) setTableGridSize(this.view, columns, rows);
    confirmTableGrid(this.view, this.getTranslate());
  }
}

export function tableGridExtension(getTranslate: () => TFunction): Extension {
  // create 必须跨状态更新保持同一个引用，否则每次悬停都会重建气泡
  const tooltip: Tooltip = {
    pos: 0,
    above: false,
    clip: false,
    create: (view) => new GridView(view, getTranslate),
  };

  /** 用户点到别处（编辑器失焦）时取消这次插入并清掉 `/查询`，但不抢回焦点 */
  const dismissOnBlur = View.domEventHandlers({
    blur(_event, view) {
      if (!view.state.field(tableGridField, false)) return false;
      cancelTableGrid(view, { focus: false });
      return false;
    },
  });

  /** 点在编辑区正文上视为放弃插入：收起网格并回删 `/查询`，然后让点击照常定位光标 */
  const dismissOnClick = View.domEventHandlers({
    mousedown(_event, view) {
      if (!view.state.field(tableGridField, false)) return false;
      cancelTableGrid(view);
      return false;
    },
  });

  return [
    tableGridField,
    Prec.highest([dismissOnBlur, dismissOnClick]),
    showTooltip.computeN([tableGridField], (state) =>
      state.field(tableGridField) ? [tooltip] : [],
    ),
    // 网格打开时接管方向键与回车；关闭时返回 false 把按键让回去
    Prec.highest(
      keymap.of([
        { key: "ArrowRight", run: (view) => stepTableGrid(view, 1, 0) },
        { key: "ArrowLeft", run: (view) => stepTableGrid(view, -1, 0) },
        { key: "ArrowDown", run: (view) => stepTableGrid(view, 0, 1) },
        { key: "ArrowUp", run: (view) => stepTableGrid(view, 0, -1) },
        { key: "Enter", run: (view) => confirmTableGrid(view, getTranslate()) },
        { key: "Escape", run: cancelTableGrid },
      ]),
    ),
    View.theme({
      ".lp-table-grid": {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "5px",
        padding: "8px",
        background: "var(--color-paper)",
        border: "1px solid color-mix(in srgb, var(--color-paper-deep) 85%, transparent)",
        borderRadius: "10px",
        boxShadow: "0 10px 28px -8px var(--color-shadow-deep), 0 2px 6px -2px var(--color-shadow)",
        userSelect: "none",
      },
      ".lp-table-grid-cells": {
        display: "grid",
        gridTemplateColumns: `repeat(${TABLE_MAX_COLUMNS}, 18px)`,
        gap: "3px",
      },
      ".lp-table-grid-cell": {
        width: "18px",
        height: "18px",
        padding: "0",
        border: "1px solid var(--color-paper-deep)",
        borderRadius: "3px",
        background: "transparent",
        cursor: "pointer",
        transition: "background-color .1s, border-color .1s",
      },
      ".lp-table-grid-cell[data-active='true']": {
        background: "var(--color-bamboo-mist)",
        borderColor: "var(--color-bamboo)",
      },
      ".lp-table-grid-label": {
        color: "var(--color-ink-ghost)",
        fontFamily: "var(--font-mono)",
        fontSize: "10px",
        letterSpacing: "0.04em",
      },
    }),
  ];
}
