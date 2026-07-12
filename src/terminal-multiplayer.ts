export type TerminalInputState = {
  line: string;
  controlSequence: "escape" | "csi" | "osc" | "oscEscape" | null;
};

type TerminalIdentity = {
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function newTerminalInputState(): TerminalInputState {
  return { line: "", controlSequence: null };
}

export function multiplayerTerminalInputPayloadsForMode(
  state: TerminalInputState,
  user: TerminalIdentity | null,
  payload: Uint8Array,
  enabled: boolean,
): Uint8Array[] {
  const submitted = terminalSubmittedLine(state, payload);
  if (!enabled || !user || !submitted || !submitted.text.trim()) {
    return [payload];
  }
  return attributedTerminalInputPayloads(user, submitted);
}

export function terminalSubmittedLine(
  state: TerminalInputState,
  payload: Uint8Array,
): { text: string; eol: string; replaceCurrentLine: boolean } | null {
  const text = decoder.decode(payload);
  if (text === "\r" || text === "\n") {
    const line = state.line;
    state.line = "";
    return { text: line, eol: text, replaceCurrentLine: true };
  }

  if (state.line && !state.controlSequence) {
    const eol = text.endsWith("\r") ? "\r" : text.endsWith("\n") ? "\n" : "";
    const line = eol ? text.slice(0, -1) : "";
    if (eol && isPlainTerminalText(line)) {
      const submitted = `${state.line}${line}`;
      state.line = "";
      return { text: submitted, eol, replaceCurrentLine: true };
    }
  }

  if (!state.line) {
    const eol = text.endsWith("\r") ? "\r" : text.endsWith("\n") ? "\n" : "";
    const line = eol ? text.slice(0, -1) : "";
    if (eol && isPlainTerminalText(line)) {
      return { text: line, eol, replaceCurrentLine: false };
    }
  }

  updateTerminalInputLine(state, text);
  return null;
}

export function attributedTerminalInputPayloads(
  user: TerminalIdentity,
  submitted: { text: string; eol: string; replaceCurrentLine: boolean },
): Uint8Array[] {
  const sender = terminalSenderTag(user);
  const attributed = `${sender} ${terminalSingleLineInput(submitted.text)}${submitted.eol}`;
  return [encoder.encode(`${submitted.replaceCurrentLine ? "\x15" : ""}${attributed}`)];
}

function updateTerminalInputLine(state: TerminalInputState, text: string): void {
  for (const char of text) {
    if (state.controlSequence) {
      state.controlSequence = nextTerminalControlSequenceState(state.controlSequence, char);
      continue;
    }
    if (char === "\x1b") {
      state.controlSequence = "escape";
      continue;
    }
    if (char === "\r" || char === "\n" || char === "\x03" || char === "\x15") {
      state.line = "";
    } else if (char === "\x7f" || char === "\b") {
      state.line = state.line.slice(0, -1);
    } else if (isPlainTerminalText(char)) {
      state.line = `${state.line}${char}`.slice(-4000);
    }
  }
}

function nextTerminalControlSequenceState(
  state: "escape" | "csi" | "osc" | "oscEscape",
  char: string,
): "escape" | "csi" | "osc" | "oscEscape" | null {
  if (state === "escape") {
    if (char === "[") return "csi";
    if (char === "]") return "osc";
    return null;
  }
  if (state === "csi") {
    const code = char.charCodeAt(0);
    return code >= 0x40 && code <= 0x7e ? null : "csi";
  }
  if (state === "osc") {
    if (char === "\x07") return null;
    if (char === "\x1b") return "oscEscape";
    return "osc";
  }
  if (char === "\\") return null;
  return char === "\x1b" ? "oscEscape" : "osc";
}

function isPlainTerminalText(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 && char !== "\n" && char !== "\r" && char !== "\t") return false;
    if (code === 127) return false;
  }
  return true;
}

function terminalSingleLineInput(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n");
}

function terminalSenderTag(user: TerminalIdentity): string {
  const name = terminalXmlAttribute(user.name ?? identityActor(user));
  return `<sender name="${name}"/>`;
}

function terminalXmlAttribute(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function identityActor(user: TerminalIdentity): string {
  return user.login ?? user.email ?? user.subject;
}
