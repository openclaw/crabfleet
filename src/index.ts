import { ContainerProxy, Sandbox as CloudflareSandboxBase } from "@cloudflare/sandbox";
import {
  APP_HTML,
  LOGO_PNG_BASE64,
  OG_IMAGE_PNG_BASE64,
  SPEC_HTML,
  SPEC_MARKDOWN,
  SPEC_V2_HTML,
  SPEC_V2_MARKDOWN,
} from "./generated";
import type { TrustedProxyAuthResult } from "./trusted-proxy-auth";
import { publicDeploymentConfig } from "./worker/deployment";
import type { RuntimeEnv } from "./worker/env";
import { json, securityHeaders, text, wantsMarkdown } from "./worker/http";
import { enforceWorkerIngressAuth, prepareWorkerIngress } from "./worker/ingress";
import { authMethods, devIdentityLogin, logout, requireUser, tokenLogin } from "./worker/auth";
import { githubCallback, githubLogin } from "./worker/github-auth";
import { handlePublicAuthRoute, handleSessionAuthRoute } from "./worker/routes/auth";
import { handleBrowserSessionRoute } from "./worker/routes/browser-sessions";
import { handleControlPlaneRoute } from "./worker/routes/control-plane";
import { handleOpenClawRoute } from "./worker/routes/openclaw";
import { handleProvisioningRoute } from "./worker/routes/provisioning";
import { handleSessionIngressRoute } from "./worker/routes/session-ingress";
import { handleServiceSessionRoute } from "./worker/routes/service-sessions";
import { terminalAssetResponse } from "./worker/terminal-assets";
import { sandboxPlaceholderOpenAIKey } from "./worker/sandbox-outbound";
import { sandboxOutbound } from "./worker/sandbox-outbound-service";
import { WorkerApplication } from "./worker/worker-application";

type SandboxClassWithOutbound = {
  outbound?: typeof sandboxOutbound;
};

export class Sandbox extends CloudflareSandboxBase<RuntimeEnv> {
  override allowedHosts = ["*"];
  override enableInternet = false;
  override envVars = {
    CRABFLEET_SANDBOX: "1",
    CURL_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    OPENAI_API_KEY: sandboxPlaceholderOpenAIKey,
    REQUESTS_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  };
  override interceptHttps = true;
}

(Sandbox as unknown as SandboxClassWithOutbound).outbound = sandboxOutbound;

export { ContainerProxy };
export { SessionControlDO } from "./worker/session-control-do";

export default {
  async fetch(request: Request, env: RuntimeEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      const ingress = prepareWorkerIngress(request, env);
      request = ingress.request;
      const { trustedProxy } = ingress;

      if (url.pathname === "/healthz") {
        return text("ok\n", "text/plain; charset=utf-8");
      }

      enforceWorkerIngressAuth(ingress);

      if (url.pathname === "/crabbox-logo.png") {
        return new Response(base64Bytes(LOGO_PNG_BASE64), {
          headers: {
            ...securityHeaders("image/png"),
            "cache-control": "public, max-age=86400",
          },
        });
      }

      if (url.pathname === "/crabfleet-og.png") {
        return new Response(base64Bytes(OG_IMAGE_PNG_BASE64), {
          headers: {
            ...securityHeaders("image/png"),
            "cache-control": "public, max-age=86400",
          },
        });
      }

      const terminalAsset = terminalAssetResponse(url.pathname);
      if (terminalAsset) return terminalAsset;

      if (url.pathname === "/docs/spec.md") {
        return text(SPEC_MARKDOWN, "text/markdown; charset=utf-8");
      }

      if (url.pathname === "/docs/spec-v2.md") {
        return text(SPEC_V2_MARKDOWN, "text/markdown; charset=utf-8");
      }

      if (url.pathname === "/docs/spec-v2" || url.pathname === "/docs/spec-v2/") {
        if (wantsMarkdown(request)) {
          return text(SPEC_V2_MARKDOWN, "text/markdown; charset=utf-8", { vary: "Accept" });
        }

        return text(SPEC_V2_HTML, "text/html; charset=utf-8", { vary: "Accept" });
      }

      if (
        url.pathname === "/docs" ||
        url.pathname === "/docs/" ||
        url.pathname === "/docs/spec" ||
        url.pathname === "/docs/spec/"
      ) {
        if (wantsMarkdown(request)) {
          return text(SPEC_MARKDOWN, "text/markdown; charset=utf-8", { vary: "Accept" });
        }

        return text(SPEC_HTML, "text/html; charset=utf-8", { vary: "Accept" });
      }

      const application = new WorkerApplication(env);
      const authResponse = await handlePublicAuthRoute(request, url, trustedProxy, {
        githubLogin: (authRequest) => githubLogin(authRequest, env),
        githubCallback: (authRequest) => githubCallback(authRequest, env),
        sshLink: (authRequest, code, requestAuth) =>
          application.sshGateway().link(authRequest, code, requestAuth),
        tokenLogin: (authRequest) => tokenLogin(authRequest, env),
        devIdentityLogin: (authRequest) => devIdentityLogin(authRequest, env),
        logout: (authRequest) => logout(authRequest, env),
        authState: (authRequest) =>
          json({
            auth: authMethods(env, authRequest),
            deployment: publicDeploymentConfig(env),
          }),
      });
      if (authResponse) return authResponse;

      if (url.pathname.startsWith("/api/")) {
        return await api(request, env, context, trustedProxy, application);
      }

      if (
        url.pathname === "/" ||
        url.pathname === "/app" ||
        url.pathname === "/app/" ||
        url.pathname === "/app/fleet" ||
        url.pathname === "/app/fleet/" ||
        url.pathname === "/app/board" ||
        url.pathname === "/app/board/" ||
        url.pathname === "/sessions" ||
        url.pathname === "/sessions/" ||
        url.pathname.startsWith("/sessions/") ||
        url.pathname.startsWith("/app/sessions/")
      ) {
        return text(APP_HTML, "text/html; charset=utf-8", { vary: "Accept" });
      }

      return new Response("Not found\n", {
        status: 404,
        headers: securityHeaders("text/plain; charset=utf-8"),
      });
    } catch (error) {
      const hasStatus = typeof error === "object" && error && "status" in error;
      const status = hasStatus ? Number(error.status) : 500;
      const message = hasStatus && error instanceof Error ? error.message : "internal error";
      return json({ error: message }, { status: Number.isFinite(status) ? status : 500 });
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: RuntimeEnv,
    context: ExecutionContext,
  ): Promise<void> {
    new WorkerApplication(env).runtime.schedule(context);
  },
} satisfies ExportedHandler<RuntimeEnv>;

async function api(
  request: Request,
  env: RuntimeEnv,
  context: ExecutionContext,
  requestAuth: TrustedProxyAuthResult,
  application: WorkerApplication,
): Promise<Response> {
  const url = new URL(request.url);

  const provisioningResponse = await handleProvisioningRoute(
    request,
    url,
    application.provisioningRoutes(),
  );
  if (provisioningResponse) return provisioningResponse;

  const serviceSessionResponse = await handleServiceSessionRoute(
    request,
    url,
    application.serviceSessionRoutes(),
  );
  if (serviceSessionResponse) return serviceSessionResponse;

  const openClawResponse = await handleOpenClawRoute(request, url, {
    controller: application.openClaw.controller(),
    automationTokens: [env.CRABBOX_OPENCLAW_TOKEN],
    roomTokens: [env.CRABBOX_OPENCLAW_TOKEN, env.CRABBOX_MULTICODEX_TOKEN],
  });
  if (openClawResponse) return openClawResponse;

  const sessionIngressResponse = await handleSessionIngressRoute(
    request,
    url,
    application.sessionIngressRoutes(requestAuth),
  );
  if (sessionIngressResponse) return sessionIngressResponse;

  const user = await requireUser(request, env, requestAuth);

  const sessionAuthResponse = handleSessionAuthRoute(request, url, user, {
    sessionState: (authRequest, authenticatedUser) =>
      json({ user: authenticatedUser, auth: authMethods(env, authRequest) }),
  });
  if (sessionAuthResponse) return sessionAuthResponse;

  const controlPlaneResponse = await handleControlPlaneRoute(
    request,
    url,
    user,
    application.controlPlaneRoutes(context),
  );
  if (controlPlaneResponse) return controlPlaneResponse;

  const browserSessionResponse = await handleBrowserSessionRoute(
    request,
    url,
    user,
    application.browserSessionRoutes(),
  );
  if (browserSessionResponse) return browserSessionResponse;

  return json({ error: "not found" }, { status: 404 });
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
