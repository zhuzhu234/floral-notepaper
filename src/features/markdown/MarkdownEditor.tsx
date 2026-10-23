import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder as placeholderExtension,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import { useTranslation } from "react-i18next";
import { livePreviewMarkdown } from "./livePreviewLanguage";
import { livePreviewExtension, type LivePreviewOptions } from "./livePreview";
import { applyMarkdownFormat, type MarkdownFormatAction } from "./formatMarkdown";
import { openSlashMenu, slashMenuExtension } from "./slashMenu";
import { selectionToolbarExtension } from "./selectionToolbar";
import { tableGridExtension } from "./tableGrid";

export interface MarkdownEditorHandle {
  focus: () => void;
  applyFormat: (action: MarkdownFormatAction) => void;
  /** 在光标处打开行首 `/` 块菜单（工具栏入口） */
  openBlockMenu: () => void;
  undo: () => void;
  redo: () => void;
  /** 在光标处插入文本（图片粘贴等场景），自动补齐前后换行 */
  insertAtCursor: (text: string) => void;
  getValue: () => string;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 切换笔记时传入不同的 key，编辑器会重置撤销历史 */
  documentKey?: string | null;
  fontSize?: number;
  imageBaseDir?: string;
  resolveImageSrc?: (src: string) => string;
  placeholder?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  onPasteFiles?: (files: File[]) => void;
  onDropFiles?: (files: File[]) => void;
  className?: string;
  ariaLabel?: string;
}

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/i;

function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (let index = 0; index < data.items.length; index++) {
    const item = data.items[index];
    if (item.kind !== "file" || !IMAGE_MIME.test(item.type)) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

export const MarkdownEditor = forwardRef<MarkdownEditorHandle, MarkdownEditorProps>(
  function MarkdownEditor(
    {
      value,
      onChange,
      documentKey = null,
      fontSize = 14,
      imageBaseDir,
      resolveImageSrc,
      placeholder = "",
      readOnly = false,
      autoFocus = false,
      onPasteFiles,
      onDropFiles,
      className = "",
      ariaLabel,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    // 所有回调都通过 ref 读取，保证编辑器实例只创建一次
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const pasteFilesRef = useRef(onPasteFiles);
    pasteFilesRef.current = onPasteFiles;
    const dropFilesRef = useRef(onDropFiles);
    dropFilesRef.current = onDropFiles;
    const translateRef = useRef(t);
    translateRef.current = t;
    const initialValueRef = useRef(value);
    const initialDocumentKeyRef = useRef(documentKey);
    const extensionsRef = useRef<import("@codemirror/state").Extension>([]);
    // 由组件自己派发、且不应回传给 onChange 的变更（外部内容同步）
    const suppressChangeRef = useRef(0);

    const fontSizeCompartment = useRef(new Compartment());
    const liveOptionsCompartment = useRef(new Compartment());
    const readOnlyCompartment = useRef(new Compartment());
    const placeholderCompartment = useRef(new Compartment());

    const buildLiveOptions = (): LivePreviewOptions => ({
      imageBaseDir,
      resolveImageSrc,
    });

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return undefined;

      const extensions: import("@codemirror/state").Extension[] = [
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        livePreviewMarkdown,
        slashMenuExtension(() => translateRef.current),
        tableGridExtension(() => translateRef.current),
        selectionToolbarExtension(() => translateRef.current),
        liveOptionsCompartment.current.of(livePreviewExtension(buildLiveOptions())),
        fontSizeCompartment.current.of(
          EditorView.theme({ ".cm-content": { fontSize: `${fontSize}px` } }),
        ),
        readOnlyCompartment.current.of(EditorView.editable.of(!readOnly)),
        placeholderCompartment.current.of(placeholder ? placeholderExtension(placeholder) : []),
        EditorView.contentAttributes.of({
          spellcheck: "false",
          "data-gramm": "false",
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          // 外部同步进来的内容已经在父组件里了，再回传会把"保存中"误标成未保存
          if (suppressChangeRef.current > 0) return;
          onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          paste: (event) => {
            const files = imageFilesFrom(event.clipboardData);
            if (files.length === 0 || !pasteFilesRef.current) return false;
            event.preventDefault();
            pasteFilesRef.current(files);
            return true;
          },
          drop: (event) => {
            const files = imageFilesFrom(event.dataTransfer);
            if (files.length === 0 || !dropFilesRef.current) return false;
            event.preventDefault();
            dropFilesRef.current(files);
            return true;
          },
          dragover: (event) => {
            const hasImage = Array.from(event.dataTransfer?.items ?? []).some(
              (item) => item.kind === "file" && IMAGE_MIME.test(item.type),
            );
            if (!hasImage) return false;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
            return true;
          },
        }),
      ];
      extensionsRef.current = extensions;

      const view = new EditorView({
        state: EditorState.create({ doc: initialValueRef.current, extensions }),
        parent: host,
      });
      viewRef.current = view;
      if (autoFocus) view.focus();

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // 编辑器实例只创建一次；后续配置变化全部走 compartment
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 外部内容替换：同一篇笔记内的刷新只替换文本，切笔记时重建状态以清空撤销历史
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      if (initialDocumentKeyRef.current !== documentKey) {
        // 切换笔记：即使新旧内容相同也要重建，否则撤销历史会跨笔记残留
        initialDocumentKeyRef.current = documentKey;
        view.setState(EditorState.create({ doc: value, extensions: extensionsRef.current }));
        return;
      }

      const current = view.state.doc.toString();
      if (current === value) return;

      suppressChangeRef.current++;
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
      suppressChangeRef.current--;
    }, [value, documentKey]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: fontSizeCompartment.current.reconfigure(
          EditorView.theme({ ".cm-content": { fontSize: `${fontSize}px` } }),
        ),
      });
    }, [fontSize]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: readOnlyCompartment.current.reconfigure(EditorView.editable.of(!readOnly)),
      });
    }, [readOnly]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: liveOptionsCompartment.current.reconfigure(
          livePreviewExtension(buildLiveOptions()),
        ),
      });
    }, [imageBaseDir, resolveImageSrc]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: placeholderCompartment.current.reconfigure(
          placeholder ? placeholderExtension(placeholder) : [],
        ),
      });
    }, [placeholder]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => viewRef.current?.focus(),
        getValue: () => viewRef.current?.state.doc.toString() ?? "",
        undo: () => {
          const view = viewRef.current;
          if (!view) return;
          view.focus();
          undo(view);
        },
        redo: () => {
          const view = viewRef.current;
          if (!view) return;
          view.focus();
          redo(view);
        },
        applyFormat: (action) => {
          const view = viewRef.current;
          if (!view) return;
          const { from, to } = view.state.selection.main;
          const result = applyMarkdownFormat(
            view.state.doc.toString(),
            from,
            to,
            action,
            translateRef.current,
          );
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: result.value },
            selection: { anchor: result.selectionStart, head: result.selectionEnd },
            scrollIntoView: true,
          });
          view.focus();
        },
        openBlockMenu: () => {
          const view = viewRef.current;
          if (!view) return;
          view.focus();
          openSlashMenu(view);
        },
        insertAtCursor: (text) => {
          const view = viewRef.current;
          if (!view) return;
          const { from } = view.state.selection.main;
          const before = view.state.doc.sliceString(0, from);
          const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
          const insertion = (needsLeadingNewline ? "\n" : "") + text + "\n";
          view.dispatch({
            changes: { from, insert: insertion },
            selection: { anchor: from + insertion.length },
            scrollIntoView: true,
          });
          view.focus();
        },
      }),
      [],
    );

    return <div ref={hostRef} className={`markdown-editor h-full min-h-0 ${className}`} />;
  },
);
