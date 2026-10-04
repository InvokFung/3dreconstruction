import { useEffect, useId, useRef } from 'react';

/**
 * Accessible modal built on <dialog> (native focus trap, Esc to close, inert background).
 */
export default function Dialog({ open, onClose, title, children, labelledBy }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal?.();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={labelledBy ?? titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
      onClick={(e) => {
        // click on the backdrop (the dialog element itself, outside its body) closes
        if (e.target === ref.current) onClose?.();
      }}
    >
      {open && (
        <div className="dialog__body">
          {title && <h2 id={titleId} style={{ fontSize: '1.25rem' }}>{title}</h2>}
          {children}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', danger, busy, onConfirm, onClose }) {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} title={title}>
      <div className="muted">{children}</div>
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className={`btn ${danger ? 'btn--danger-solid' : 'btn--primary'}`}
          onClick={onConfirm}
          disabled={busy}
          autoFocus
        >
          {busy && <span className="spinner" aria-hidden="true" />}
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
