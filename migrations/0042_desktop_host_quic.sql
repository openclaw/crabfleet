ALTER TABLE desktop_hosts
  ADD COLUMN quic_port INTEGER CHECK (quic_port IS NULL OR (quic_port >= 1 AND quic_port <= 65535));

ALTER TABLE desktop_hosts
  ADD COLUMN quic_cert_hash TEXT;

-- Probe-only capability. The Worker stores and returns this flag, but does not
-- attempt WebTransport ingress until Cloudflare exposes a GA Worker API.
ALTER TABLE desktop_hosts
  ADD COLUMN webtransport INTEGER NOT NULL DEFAULT 0 CHECK (webtransport IN (0, 1));
