export type AuthorizedSessionRefreshStore<T> = {
  read(): Promise<T | null>;
  authorize(session: T): Promise<boolean>;
  refresh(): Promise<void>;
};

export async function readAuthorizedFreshSession<T>(
  store: AuthorizedSessionRefreshStore<T>,
): Promise<T | null> {
  const initial = await store.read();
  if (!initial || !(await store.authorize(initial))) return null;
  await store.refresh();
  const current = await store.read();
  return current && (await store.authorize(current)) ? current : null;
}
