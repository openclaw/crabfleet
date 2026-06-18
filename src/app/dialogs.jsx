import { useLayoutEffect, useReducer, useRef, useState } from "preact/hooks";

import { Icon } from "./components.jsx";
import { actionDialogReducer, initialActionDialogState } from "./dialog-state.js";

export function useActionDialog() {
  const [state, dispatch] = useReducer(actionDialogReducer, initialActionDialogState);

  function openActionDialog(options) {
    dispatch({ type: "open", options });
  }

  function closeActionDialog() {
    dispatch({ type: "close" });
  }

  async function confirmActionDialog() {
    const current = state.dialog;
    if (!current?.action || current.pending) return;
    dispatch({ type: "start", id: current.id });
    try {
      await current.action();
      dispatch({ type: "resolve", id: current.id });
    } catch (error) {
      dispatch({
        type: "reject",
        id: current.id,
        message: error?.message || "The action could not be completed.",
      });
    }
  }

  return {
    dialog: state.dialog,
    openActionDialog,
    closeActionDialog,
    confirmActionDialog,
  };
}

export function Drawer({ id, open, title, wide, onClose, children }) {
  const elementRef = useRef(null);
  const titleId = `${id}-title`;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!open || !element) return;
    const previousFocus = document.activeElement;
    if (!element.open) element.showModal();
    element
      .querySelector(
        ".panel-body input, .panel-body select, .panel-body textarea, .panel-body button",
      )
      ?.focus();
    return () => {
      if (element.open) element.close();
      previousFocus?.focus?.();
    };
  }, [open]);

  return (
    <dialog
      ref={elementRef}
      class={`drawer ${open ? "open" : ""}`}
      id={id}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <section class={`panel ${wide ? "wide" : ""}`}>
        <div class="panel-head">
          <h2 id={titleId}>{title}</h2>
          <button class="icon" aria-label={`Close ${title}`} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="panel-body">{children}</div>
      </section>
    </dialog>
  );
}

export function ActionDialog({ dialog, onCancel, onConfirm }) {
  const elementRef = useRef(null);
  const cancelRef = useRef(null);
  const valueRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useLayoutEffect(() => {
    if (!dialog) return;
    const element = elementRef.current;
    const previousFocus = document.activeElement;
    setCopied(false);
    if (element && !element.open) element.showModal();
    const focusTarget = dialog.kind === "share" ? valueRef.current : cancelRef.current;
    focusTarget?.focus();
    if (dialog.kind === "share") focusTarget?.select();
    return () => {
      if (element?.open) element.close();
      previousFocus?.focus?.();
    };
  }, [dialog?.id]);

  if (!dialog) return null;
  const titleId = `action-dialog-title-${dialog.id}`;
  const descriptionId = `action-dialog-description-${dialog.id}`;

  async function copyValue() {
    const value = dialog.value || "";
    let success = false;
    try {
      await navigator.clipboard?.writeText(value);
      success = Boolean(navigator.clipboard);
    } catch {}
    if (!success && valueRef.current) {
      valueRef.current.select();
      success = Boolean(document.execCommand?.("copy"));
    }
    setCopied(success);
  }

  return (
    <dialog
      ref={elementRef}
      class={`action-dialog ${dialog.kind === "danger" ? "danger" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!dialog.pending) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !dialog.pending) onCancel();
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <section class="action-dialog-surface">
        <div class="action-dialog-content">
          <div class="action-dialog-icon" aria-hidden="true">
            <Icon name={dialog.kind === "danger" ? "triangle-alert" : "link-2"} />
          </div>
          <div class="action-dialog-copy">
            <span class="action-dialog-eyebrow">{dialog.eyebrow}</span>
            <h2 id={titleId}>{dialog.title}</h2>
            <p id={descriptionId}>{dialog.description}</p>
          </div>
          {dialog.subject ? <code class="action-dialog-subject">{dialog.subject}</code> : null}
          {dialog.kind === "share" ? (
            <label class="action-dialog-value">
              Share URL
              <input ref={valueRef} readonly value={dialog.value || ""} />
            </label>
          ) : null}
          {dialog.error ? (
            <div class="action-dialog-error" role="alert">
              {dialog.error}
            </div>
          ) : null}
        </div>
        <div class="action-dialog-actions">
          {dialog.kind === "share" ? (
            <>
              <button ref={cancelRef} onClick={onCancel}>
                Done
              </button>
              <button class="primary" onClick={() => void copyValue()}>
                <Icon name={copied ? "check" : "copy"} />
                <span aria-live="polite" aria-atomic="true">
                  {copied ? "Copied" : "Copy link"}
                </span>
              </button>
            </>
          ) : (
            <>
              <button ref={cancelRef} disabled={dialog.pending} onClick={onCancel}>
                Cancel
              </button>
              <button
                class="action-dialog-danger"
                disabled={dialog.pending}
                onClick={() => void onConfirm()}
              >
                {dialog.pending ? "Working..." : dialog.confirmLabel}
              </button>
            </>
          )}
        </div>
      </section>
    </dialog>
  );
}
