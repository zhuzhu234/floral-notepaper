import { Suspense, lazy, forwardRef } from "react";
import type { ComponentProps, ForwardedRef } from "react";

// CodeMirror + Lezer 语法链是实时编辑模式的主要体积来源。
// 懒加载后只有真正切到"实时"视图时才下载，纯分栏/预览用户不受影响。
const MarkdownEditorInner = lazy(() =>
  import("./MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })),
);

type InnerHandle = import("./MarkdownEditor").MarkdownEditorHandle;
type InnerProps = ComponentProps<typeof MarkdownEditorInner>;

export const MarkdownEditorLazy = forwardRef<InnerHandle, InnerProps>(function MarkdownEditorLazy(
  props: InnerProps,
  ref: ForwardedRef<InnerHandle>,
) {
  return (
    <Suspense fallback={null}>
      <MarkdownEditorInner {...props} ref={ref} />
    </Suspense>
  );
});
