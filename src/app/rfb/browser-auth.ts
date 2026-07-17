export type BrowserRFBAuthenticationOptions = {
  password: string;
  onVNCAuthentication(succeeded: boolean): void;
};

// The project's tsconfig does not pull in the DOM lib for this module, so the
// storage surface is described structurally rather than via the DOM `Storage`.
interface BrowserCredentialStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export async function browserDirectRFBAuthentication(
  hostID: string,
  storage: BrowserCredentialStorage | null,
  promptForPassword: () => string | null | Promise<string | null>,
): Promise<BrowserRFBAuthenticationOptions> {
  const key = `crabfleet.rfb.password.${hostID}`;
  let saved: string | null = null;
  try {
    saved = storage?.getItem(key) ?? null;
  } catch {
    // Private browsing and browser policy may make sessionStorage unavailable.
  }
  const password = saved ?? (await promptForPassword());
  if (password === null) throw new Error("RFB password entry cancelled");
  return {
    password,
    onVNCAuthentication(succeeded) {
      try {
        if (succeeded) storage?.setItem(key, password);
        else storage?.removeItem(key);
      } catch {
        // Authentication remains valid even when tab-scoped caching is unavailable.
      }
    },
  };
}
