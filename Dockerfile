FROM docker.io/cloudflare/sandbox:0.12.8

USER root

ARG CRABBOX_VERSION=0.17.1
ARG CRABBOX_SHA256_AMD64=
ARG CRABBOX_SHA256_ARM64=

RUN set -eux; \
  apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    dnsutils \
    fd-find \
    git \
    git-lfs \
    gnupg \
    iproute2 \
    jq \
    less \
    lsof \
    make \
    nano \
    netcat-openbsd \
    openssh-client \
    pkg-config \
    procps \
    psmisc \
    python3 \
    python3-pip \
    python3-venv \
    ripgrep \
    rsync \
    shellcheck \
    sqlite3 \
    time \
    unzip \
    vim-tiny \
    xz-utils \
    zip; \
  mkdir -p /etc/apt/keyrings; \
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list; \
  apt-get update; \
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh; \
  rm -rf /var/lib/apt/lists/*; \
  ln -sf /usr/bin/fdfind /usr/local/bin/fd; \
  git lfs install --system; \
  git config --system --add safe.directory '*'; \
  mkdir -p /workspace /tmp

RUN set -eux; \
  npm install -g corepack pnpm@latest @openai/codex@latest; \
  corepack enable || true; \
  pnpm --version; \
  codex --version

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) \
      override_checksum="$CRABBOX_SHA256_AMD64"; \
      checksum_arg="CRABBOX_SHA256_AMD64"; \
      pinned_checksum="3c41839257e4622e28bcec8b0f0153f19d78d436fd548894a7c7d7726d922611" \
      ;; \
    arm64) \
      override_checksum="$CRABBOX_SHA256_ARM64"; \
      checksum_arg="CRABBOX_SHA256_ARM64"; \
      pinned_checksum="4bf87a0d2365441ee2f8cb34183cfd9ebeb065111697eb2d8dc867b3a627fdd2" \
      ;; \
    *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
  esac; \
  archive="crabbox_${CRABBOX_VERSION}_linux_${arch}.tar.gz"; \
  if [ "$CRABBOX_VERSION" = "0.17.1" ]; then \
    checksum="$pinned_checksum"; \
  else \
    checksum="$override_checksum"; \
    if [ -z "$checksum" ]; then \
      echo "an explicit $checksum_arg is required for non-default versions" >&2; \
      exit 1; \
    fi; \
  fi; \
  printf '%s\n' "$checksum" | grep -Eq '^[0-9a-f]{64}$'; \
  curl -fsSL \
    "https://github.com/openclaw/crabbox/releases/download/v${CRABBOX_VERSION}/${archive}" \
    -o /tmp/crabbox.tar.gz; \
  echo "$checksum  /tmp/crabbox.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/crabbox.tar.gz -C /usr/local/bin crabbox; \
  chmod +x /usr/local/bin/crabbox; \
  rm -f /tmp/crabbox.tar.gz; \
  crabbox --version

RUN cat >/usr/local/bin/crabbox-diagnostics <<'EOF' && chmod +x /usr/local/bin/crabbox-diagnostics
#!/usr/bin/env bash
set -u

tools=(
  bash git gh node npm pnpm codex rg fd jq python3 pip3 make gcc
  time ssh rsync curl unzip zip sqlite3 shellcheck crabbox
)

printf 'Crabfleet sandbox diagnostics\n'
printf 'image: %s\n' "${CRABBOX_IMAGE_VERSION:-dev}"
printf 'cwd: %s\n' "$(pwd)"
for tool in "${tools[@]}"; do
  if path="$(command -v "$tool" 2>/dev/null)"; then
    version="$("$tool" --version 2>/dev/null | head -n 1 || true)"
    printf 'ok %-10s %s %s\n' "$tool" "$path" "$version"
  else
    printf 'missing %-10s\n' "$tool"
  fi
done
EOF

ENV TERM=xterm-256color
ENV COLORTERM=truecolor
ENV CRABBOX_IMAGE_VERSION=2026-05-22-tools

EXPOSE 3000
