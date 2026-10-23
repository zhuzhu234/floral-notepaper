import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  buildBlockCommands,
  matchBlockCommands,
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  type BlockCommandId,
  type TableSize,
} from "../features/markdown/blockCommands";

export interface BlockMenuAnchor {
  x: number;
  y: number;
}

interface BlockCommandMenuProps {
  anchor: BlockMenuAnchor;
  onSelect: (id: BlockCommandId, tableSize?: TableSize) => void;
  onClose: () => void;
}

const MENU_MARGIN = 8;
const MENU_WIDTH = 220;
const MENU_MAX_HEIGHT = 320;

/** 超出视口时向内收，避免贴边被裁掉 */
function clampAnchor(anchor: BlockMenuAnchor): BlockMenuAnchor {
  const x = Math.min(anchor.x, window.innerWidth - MENU_WIDTH - MENU_MARGIN);
  const y = Math.min(anchor.y, window.innerHeight - MENU_MAX_HEIGHT - MENU_MARGIN);
  return { x: Math.max(MENU_MARGIN, x), y: Math.max(MENU_MARGIN, y) };
}

/**
 * 编辑 / 分栏模式（textarea）下的块菜单。
 *
 * 实时模式用 CodeMirror 的 `/` 补全原地打字筛选；textarea 没有补全基础设施，
 * 这里用同一份命令表和匹配规则做一个带搜索框的弹层。纯文本输入框里
 * 不拦截 `/`（路径等正常输入不该被抢走），入口是工具栏按钮与 Ctrl+/。
 *
 * 选「表格」时面板切换成网格，先定行列再插入，与实时模式保持一致。
 */
export function BlockCommandMenu({ anchor, onSelect, onClose }: BlockCommandMenuProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [tableSize, setTableSize] = useState<TableSize | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const commands = useMemo(() => buildBlockCommands(t), [t]);
  const filtered = useMemo(() => matchBlockCommands(commands, query), [commands, query]);
  const position = useMemo(() => clampAnchor(anchor), [anchor]);

  useEffect(() => {
    if (tableSize) {
      // 网格步骤里搜索框被卸载，焦点交给面板本身，方向键才不会丢
      panelRef.current?.focus();
      return;
    }
    inputRef.current?.focus();
  }, [tableSize]);

  // 过滤结果变化后把高亮项收回到第一项，避免索引越界
  useEffect(() => {
    setActive(0);
  }, [query]);

  // 键盘移动选中项时把它滚进可视区
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (panelRef.current?.contains(event.target as Node)) return;
      onClose();
    }
    // 捕获阶段监听：点在编辑区时先关菜单，再把点击交给编辑器
    document.addEventListener("mousedown", handlePointerDown, true);
    return () => document.removeEventListener("mousedown", handlePointerDown, true);
  }, [onClose]);

  const pick = (index: number) => {
    const command = filtered[index];
    if (!command) return;
    if (command.id === "table") {
      setTableSize({ columns: 2, rows: 2 });
      return;
    }
    onSelect(command.id);
  };

  const confirmTable = (size: TableSize) => {
    setTableSize(null);
    onSelect("table", size);
  };

  /** 网格步骤的方向键与确认键；到边界后停住不回绕 */
  const handleGridKey = (event: KeyboardEvent) => {
    if (!tableSize) return;
    const step = (dc: number, dr: number) => {
      event.preventDefault();
      setTableSize({
        columns: Math.max(1, Math.min(TABLE_MAX_COLUMNS, tableSize.columns + dc)),
        rows: Math.max(1, Math.min(TABLE_MAX_ROWS, tableSize.rows + dr)),
      });
    };

    switch (event.key) {
      case "ArrowRight":
        step(1, 0);
        return;
      case "ArrowLeft":
        step(-1, 0);
        return;
      case "ArrowDown":
        step(0, 1);
        return;
      case "ArrowUp":
        step(0, -1);
        return;
      case "Enter":
        event.preventDefault();
        confirmTable(tableSize);
        return;
      case "Escape":
        // 网格里先退回命令列表，再按一次才关面板
        event.preventDefault();
        setTableSize(null);
        return;
    }
  };

  return (
    <div
      ref={panelRef}
      className="block-menu"
      style={{ left: position.x, top: position.y, width: MENU_WIDTH, maxHeight: MENU_MAX_HEIGHT }}
      role="dialog"
      aria-label={t(tableSize ? "main.slash.table.pick" : "main.slash.insert", {
        defaultValue: tableSize ? "选择表格尺寸" : "插入块",
      })}
      tabIndex={tableSize ? -1 : undefined}
      onKeyDown={handleGridKey}
    >
      {tableSize ? (
        <div className="block-menu-grid">
          <div className="block-menu-grid-cells">
            {Array.from({ length: TABLE_MAX_ROWS }, (_, row) =>
              Array.from({ length: TABLE_MAX_COLUMNS }, (_, column) => {
                const highlighted = column < tableSize.columns && row < tableSize.rows;
                return (
                  <button
                    key={`${column}-${row}`}
                    type="button"
                    className="block-menu-grid-cell"
                    data-active={highlighted}
                    aria-label={`${column + 1} × ${row + 1}`}
                    onMouseEnter={() => setTableSize({ columns: column + 1, rows: row + 1 })}
                    // 按下时不抢焦点，面板的键盘处理才能继续生效
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => confirmTable({ columns: column + 1, rows: row + 1 })}
                  />
                );
              }),
            )}
          </div>
          <div className="block-menu-grid-label">
            {t("main.slash.table.size", {
              columns: tableSize.columns,
              rows: tableSize.rows,
              defaultValue: "{{columns}} 列 × {{rows}} 行",
            })}
          </div>
          <div className="block-menu-grid-hint">
            {t("main.slash.table.hint", { defaultValue: "方向键调整，回车插入" })}
          </div>
          <button
            type="button"
            className="block-menu-grid-back"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setTableSize(null)}
          >
            {t("main.slash.back", { defaultValue: "返回" })}
          </button>
        </div>
      ) : (
        <>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => (filtered.length ? (current + 1) % filtered.length : 0));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) =>
                  filtered.length ? (current - 1 + filtered.length) % filtered.length : 0,
                );
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                pick(active);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder={t("main.slash.searchPlaceholder", { defaultValue: "搜索块…" })}
            className="block-menu-search"
            spellCheck={false}
            aria-label={t("main.slash.searchPlaceholder", { defaultValue: "搜索块…" })}
          />
          <ul ref={listRef} className="block-menu-list" role="listbox">
            {filtered.map((command, index) => (
              <li
                key={command.id}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(index)}
                className="block-menu-option"
              >
                <span className="block-menu-label">{command.label}</span>
                {command.syntax && <span className="block-menu-syntax">{command.syntax}</span>}
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="block-menu-empty">
                {t("main.slash.empty", { defaultValue: "没有匹配的块" })}
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}
