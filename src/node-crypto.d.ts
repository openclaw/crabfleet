declare module "node:crypto" {
  type Hmac = {
    update(data: string): Hmac;
    digest(encoding: "base64url"): string;
  };

  export function createHmac(algorithm: "sha256", key: string): Hmac;
}
