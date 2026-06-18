import { useEffect, useRef } from "preact/hooks";
import { api } from "./api.js";
import { linkedInteractiveSessionPlaceholder } from "./utils.js";

export function linkedSessionFailure(id, status, sharedToken) {
  return linkedInteractiveSessionPlaceholder(id, {
    status: "unavailable",
    lastEvent:
      status === 404
        ? "Codex session was not found."
        : "You do not have access to this Codex session.",
    sharedReadOnly: Boolean(sharedToken),
  });
}

export function useLinkedSession({
  sharedSessionId,
  sharedToken,
  signedIn,
  focusedSessionId,
  interactiveSessions,
  openedRef,
  findInteractiveSession,
  upsertInteractiveSession,
  loadSharedSession,
  setFocusedSessionId,
  openSessionGrid,
}) {
  const callbacksRef = useRef();
  callbacksRef.current = {
    findInteractiveSession,
    upsertInteractiveSession,
    loadSharedSession,
    setFocusedSessionId,
    openSessionGrid,
  };

  useEffect(() => {
    if (!sharedSessionId) return;
    let cancelled = false;

    async function openLinkedSession() {
      const {
        findInteractiveSession,
        upsertInteractiveSession,
        loadSharedSession,
        setFocusedSessionId,
        openSessionGrid,
      } = callbacksRef.current;
      const existing = findInteractiveSession(sharedSessionId);
      if (!existing || existing.routePlaceholder) {
        if (
          signedIn &&
          (!openedRef.current || focusedSessionId === sharedSessionId) &&
          existing?.status !== "unavailable"
        ) {
          try {
            const result = await api(
              `/api/interactive-sessions/${encodeURIComponent(sharedSessionId)}`,
            );
            if (cancelled) return;
            upsertInteractiveSession(result.session);
            openedRef.current = true;
            setFocusedSessionId(result.session.id);
            openSessionGrid(result.session.id, { deepLink: true });
          } catch (error) {
            if (cancelled) return;
            if (error.status !== 403 && error.status !== 404) throw error;
            upsertInteractiveSession(
              linkedSessionFailure(sharedSessionId, error.status, sharedToken),
            );
            openedRef.current = true;
            setFocusedSessionId(sharedSessionId);
            openSessionGrid(sharedSessionId);
          }
        } else if (
          !signedIn &&
          sharedToken &&
          existing?.status !== "unavailable" &&
          !document.body.classList.contains("locked")
        ) {
          await loadSharedSession();
        } else if (!openedRef.current) {
          if (!existing) {
            upsertInteractiveSession(
              linkedInteractiveSessionPlaceholder(sharedSessionId, {
                sharedReadOnly: Boolean(sharedToken),
              }),
            );
          }
          openedRef.current = true;
          setFocusedSessionId(sharedSessionId);
          openSessionGrid(sharedSessionId);
        }
        return;
      }
      if (openedRef.current && focusedSessionId !== sharedSessionId) return;
      openedRef.current = true;
      setFocusedSessionId(sharedSessionId);
      openSessionGrid(sharedSessionId);
    }

    void openLinkedSession().catch((error) => {
      if (!cancelled) console.warn("Linked session open failed", error);
    });
    return () => {
      cancelled = true;
    };
  }, [sharedSessionId, sharedToken, signedIn, focusedSessionId, interactiveSessions, openedRef]);
}
