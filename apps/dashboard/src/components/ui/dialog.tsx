import * as React from "react";
import { Dialog as BaseDialog } from "@base-ui-components/react/dialog";

/** A shadcn-styled modal dialog built on the Base UI Dialog primitive (focus trap, esc, backdrop). */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  return (
    <BaseDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-40 bg-black/55" />
        <BaseDialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(640px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 shadow-2xl outline-none">
          <BaseDialog.Title className="mb-3 text-base font-semibold">{title}</BaseDialog.Title>
          {children}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
