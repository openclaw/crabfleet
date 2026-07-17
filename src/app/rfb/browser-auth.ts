export type BrowserRFBAuthenticationOptions = {
  password: string;
  onVNCAuthentication(succeeded: boolean): void;
};

type BrowserCredentialStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function browserDirectRFBAuthentication(
  hostID: string,
  storage: BrowserCredentialStorage | null,
  promptForPassword: () => string | null,
): BrowserRFBAuthenticationOptions {
  const key = `crabfleet.rfb.password.${hostID}`;
  let saved: string | null = null;
  try {
    saved = storage?.getItem(key) ?? null;
  } catch {
    // Private browsing and browser policy may make sessionStorage unavailable.
  }
  const password = saved ?? promptForPassword();
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
