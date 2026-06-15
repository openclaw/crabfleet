import { useEffect, useState } from "preact/hooks";
import { configureTerminalHub, disposeAllTerminals } from "./terminal.js";
import { sessionItems } from "./utils.js";

export function mergeTerminalStatus(current, id, label) {
  if (current[id] === label) return current;
  return { ...current, [id]: label };
}

export function useTerminalHubState({ sharedSessionId, sharedToken, stateRef }) {
  const [terminalStatus, setTerminalStatus] = useState({});

  useEffect(() => {
    configureTerminalHub({
      sharedSessionId,
      sharedToken,
      sessions: () => sessionItems(stateRef.current),
      onStatus: (id, label) =>
        setTerminalStatus((current) => mergeTerminalStatus(current, id, label)),
    });
    return () => {
      configureTerminalHub({ sessions: () => [], onStatus() {} });
      disposeAllTerminals();
    };
  }, [sharedSessionId, sharedToken, stateRef]);

  return terminalStatus;
}
