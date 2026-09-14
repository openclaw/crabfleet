import { APP_HTML, BROWSER_ASSETS, LOGO_PNG_BASE64 } from "./generated.ts";
import { publicDeploymentConfig } from "./worker/deployment.ts";
import type { RuntimeEnv } from "./worker/env.ts";
import { json, securityHeaders, text } from "./worker/http.ts";
import { enforceWorkerIngressAuth, prepareWorkerIngress } from "./worker/ingress.ts";
import { authMethods, devIdentityLogin, logout, requireUser, tokenLogin } from "./worker/auth.ts";
import { githubCallback, githubLogin } from "./worker/github-auth.ts";
import { handlePublicAuthRoute } from "./worker/routes/auth.ts";
import { handleNativeRoute } from "./worker/routes/native.ts";
import { handleConnectorRoute } from "./worker/routes/connector.ts";
import { handleDesktopHostRoute } from "./worker/routes/desktop-hosts.ts";
import { handleAccessRoute } from "./worker/routes/access.ts";
import { WorkerApplication } from "./worker/worker-application.ts";
import { handleNativeLink } from "./worker/native-link.ts";
import { DesktopHostRepository } from "./worker/desktop-host-repository.ts";
import { DesktopRelayService, matchDesktopRelayRoute } from "./worker/desktop-relay-service.ts";

export { DesktopRelayDO } from "./worker/desktop-relay-do.ts";

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);
    try {
      const ingress = prepareWorkerIngress(request, env);
      request = ingress.request;
      const { trustedProxy } = ingress;
      if (url.pathname === "/healthz") return text("ok\n", "text/plain; charset=utf-8");
      enforceWorkerIngressAuth(ingress);

      const browserAsset = BROWSER_ASSETS[url.pathname];
      if (browserAsset && (request.method === "GET" || request.method === "HEAD")) {
        return new Response(
          Uint8Array.from(atob(browserAsset.base64), (value) => value.charCodeAt(0)),
          {
            headers: securityHeaders(browserAsset.contentType),
          },
        );
      }
      if (url.pathname === "/crabbox-logo.png") {
        return new Response(
          Uint8Array.from(atob(LOGO_PNG_BASE64), (value) => value.charCodeAt(0)),
          {
            headers: securityHeaders("image/png"),
          },
        );
      }
      const application = new WorkerApplication(env);
      const authResponse = await handlePublicAuthRoute(request, url, trustedProxy, {
        githubLogin: (req) => githubLogin(req, env),
        githubCallback: (req) => githubCallback(req, env),
        nativeLink: (req, code, requestAuth) =>
          handleNativeLink(req, code, requestAuth, env, application.nativeAuth),
        tokenLogin: (req) => tokenLogin(req, env),
        devIdentityLogin: (req) => devIdentityLogin(req, env),
        logout: (req) => logout(req, env),
        authState: (req) =>
          json({ auth: authMethods(env, req), deployment: publicDeploymentConfig(env) }),
      });
      if (authResponse) return authResponse;

      const nativeResponse = await handleNativeRoute(
        request,
        url,
        trustedProxy,
        application.nativeRoutes(),
      );
      if (nativeResponse) return nativeResponse;
      const connectorResponse = await handleConnectorRoute(
        request,
        url,
        trustedProxy,
        application.nativeAuth,
        application.hosts,
      );
      if (connectorResponse) return connectorResponse;

      const relay = matchDesktopRelayRoute(url);
      if (relay?.role === "host") {
        return await new DesktopRelayService(env, new DesktopHostRepository(env)).openHost(
          request,
          relay.hostID,
        );
      }
      if (url.pathname.startsWith("/api/")) {
        const user = await requireUser(request, env, trustedProxy);
        if (relay?.role === "viewer") {
          return await new DesktopRelayService(env, new DesktopHostRepository(env)).openViewer(
            request,
            user,
            relay.hostID,
          );
        }
        if (request.method === "GET" && url.pathname === "/api/session") {
          return json({ user, auth: authMethods(env, request) });
        }
        if (request.method === "GET" && url.pathname === "/api/fleet") {
          return json({ fleet: await application.readFleet(user) });
        }
        const hostResponse = await handleDesktopHostRoute(request, url, user, application.hosts);
        if (hostResponse) return hostResponse;
        const accessResponse = await handleAccessRoute(request, url, user, env);
        if (accessResponse) return accessResponse;
      }
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        (["/", "/app", "/app/", "/app/fleet", "/app/fleet/"].includes(url.pathname) ||
          /^\/app\/desktops\/[^/]+\/?$/u.test(url.pathname))
      ) {
        return text(APP_HTML, "text/html; charset=utf-8");
      }
      return json({ error: "not found" }, { status: 404 });
    } catch (error) {
      const hasStatus = typeof error === "object" && error && "status" in error;
      const status = hasStatus ? Number(error.status) : 500;
      const message = hasStatus && error instanceof Error ? error.message : "internal error";
      return json({ error: message }, { status: Number.isFinite(status) ? status : 500 });
    }
  },
  async scheduled(_controller: ScheduledController, env: RuntimeEnv): Promise<void> {
    await new WorkerApplication(env).nativeAuth.pruneExpired();
  },
} satisfies ExportedHandler<RuntimeEnv>;
