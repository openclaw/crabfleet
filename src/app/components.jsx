import { useState } from "preact/hooks";

export function CopyCommand({ value, className = "" }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <button
      class={`terminal-command ${className}`.trim()}
      type="button"
      onClick={() => void copy()}
      title="Copy command"
    >
      <code>{value}</code>
      <span class="copy-feedback" aria-live="polite">
        {copied ? "Copied" : <Icon name="copy" />}
      </span>
    </button>
  );
}

export function Icon({ name }) {
  const nodes = globalThis.lucideIconNodes?.[name];
  if (!nodes) return null;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {nodes.map(([tag, attrs], index) => {
        const Tag = tag;
        return <Tag key={`${tag}-${index}`} {...attrs} />;
      })}
    </svg>
  );
}
