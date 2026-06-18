export function isLoginScreenHidden({
  signedIn,
  sharedSessionId,
  sharedToken,
  loginMessage,
  user,
}) {
  return (
    signedIn ||
    Boolean(sharedSessionId && sharedToken && !loginMessage) ||
    (user?.subject === "shared" && !loginMessage)
  );
}

export function developmentIdentityDefaults(user) {
  return {
    id: user?.subject?.startsWith("dev:")
      ? user.subject.slice("dev:".length)
      : user?.login || "admin-1",
    name: user?.name || user?.login || "Admin 1",
    role: user?.role || "owner",
  };
}
