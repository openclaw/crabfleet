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

  async function confirmActionDialog(input) {
    const current = state.dialog;
    if (!current?.action || current.pending) return;
    dispatch({ type: "start", id: current.id });
    try {
      await current.action(input);
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
  const principalRef = useRef(null);
  const [copied, setCopied] = useState(false);
  const [accessGrants, setAccessGrants] = useState([]);
  const [revoking, setRevoking] = useState("");
  const [revokeError, setRevokeError] = useState("");

  useLayoutEffect(() => {
    if (!dialog) return;
    const element = elementRef.current;
    const previousFocus = document.activeElement;
    setCopied(false);
    setAccessGrants(dialog.grants || []);
    setRevoking("");
    setRevokeError("");
    if (element && !element.open) element.showModal();
    const focusTarget =
      dialog.kind === "share"
        ? valueRef.current
        : dialog.kind === "access"
          ? principalRef.current
          : cancelRef.current;
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
  const accessFormId = `action-dialog-access-${dialog.id}`;
  const errorMessage = dialog.error || revokeError;

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

  async function revokeGrant(subject) {
    if (!dialog.revoke || revoking || dialog.pending) return;
    setRevoking(subject);
    setRevokeError("");
    try {
      await dialog.revoke(subject);
      setAccessGrants((grants) => grants.filter((grant) => grant.subject !== subject));
    } catch (error) {
      setRevokeError(error?.message || "Access could not be revoked.");
    } finally {
      setRevoking("");
    }
  }

  return (
    <dialog
      ref={elementRef}
      class={`action-dialog ${dialog.kind === "danger" ? "danger" : ""} ${
        dialog.kind === "access" ? "access" : ""
      }`}
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
            <Icon
              name={
                dialog.kind === "danger"
                  ? "triangle-alert"
                  : dialog.kind === "access"
                    ? "user-plus"
                    : "link-2"
              }
            />
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
          {dialog.kind === "access" ? (
            <div class="action-dialog-access">
              <form
                id={accessFormId}
                class="action-dialog-access-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  void onConfirm({
                    principal: data.get("principal"),
                    role: data.get("role"),
                    expiresInSeconds: Number(data.get("expiresInSeconds")),
                  });
                }}
              >
                <label class="full">
                  User login or email
                  <input
                    ref={principalRef}
                    name="principal"
                    autocomplete="off"
                    placeholder="teammate@example.com"
                    required
                  />
                </label>
                <label>
                  Access
                  <select name="role" defaultValue="viewer">
                    <option value="viewer">Read only</option>
                    <option value="controller">Terminal control</option>
                  </select>
                </label>
                <label>
                  Expires
                  <select name="expiresInSeconds" defaultValue="86400">
                    <option value="3600">1 hour</option>
                    <option value="86400">24 hours</option>
                    <option value="604800">7 days</option>
                    <option value="2592000">30 days</option>
                  </select>
                </label>
              </form>
              <div class="action-dialog-grants">
                <strong>Current access</strong>
                {accessGrants.length ? (
                  accessGrants.map((grant) => (
                    <div class="action-dialog-grant" key={grant.subject}>
                      <span>
                        <strong>{grant.principal}</strong>
                        <small>
                          {grant.role === "controller" ? "Terminal control" : "Read only"}
                          {grant.expiresAt
                            ? ` · expires ${new Date(grant.expiresAt).toLocaleString()}`
                            : ""}
                        </small>
                      </span>
                      <button
                        type="button"
                        disabled={Boolean(dialog.pending || revoking)}
                        onClick={() => void revokeGrant(grant.subject)}
                      >
                        {revoking === grant.subject ? "Revoking…" : "Revoke"}
                      </button>
                    </div>
                  ))
                ) : (
                  <span class="action-dialog-grants-empty">No named access grants.</span>
                )}
              </div>
            </div>
          ) : null}
          {errorMessage ? (
            <div class="action-dialog-error" role="alert">
              {errorMessage}
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
          ) : dialog.kind === "access" ? (
            <>
              <button ref={cancelRef} disabled={dialog.pending} onClick={onCancel}>
                Done
              </button>
              <button class="primary" type="submit" form={accessFormId} disabled={dialog.pending}>
                {dialog.pending ? "Granting…" : dialog.confirmLabel}
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
