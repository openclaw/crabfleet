#!/bin/sh
set -eu

for dependency in go sway wayvnc wev stdbuf setsid dbus-run-session; do
  command -v "$dependency" >/dev/null 2>&1 || {
    echo "Missing $dependency (live proof needs Sway, wayvnc 0.10+, and wev)." >&2
    exit 1
  }
done

cd "$(dirname "$0")/.."
proof_directory=$(mktemp -d /tmp/cfl.XXXXXX)
compositor_pid=
cleanup() {
  if [ -n "$compositor_pid" ]; then
    kill -- "-$compositor_pid" 2>/dev/null || true
    wait "$compositor_pid" 2>/dev/null || true
  fi
  rm -rf "$proof_directory"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
mkdir -m 700 "$proof_directory/run"
cat > "$proof_directory/sway.conf" <<'EOF'
xwayland disable
output HEADLESS-1 mode 640x480
seat seat0 fallback true
EOF

# A separate compositor, runtime directory, session bus, and process group keep
# proof capture and injected input away from the operator's active desktop.
env -u DISPLAY -u WAYLAND_DISPLAY -u SWAYSOCK -u HYPRLAND_INSTANCE_SIGNATURE \
  XDG_RUNTIME_DIR="$proof_directory/run" WLR_BACKENDS=headless \
  WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 \
  setsid dbus-run-session -- sway -c "$proof_directory/sway.conf" \
  > "$proof_directory/sway.log" 2>&1 &
compositor_pid=$!

wayland_socket=
attempt=0
while [ "$attempt" -lt 100 ]; do
  for candidate in "$proof_directory"/run/wayland-*; do
    if [ -S "$candidate" ]; then
      wayland_socket=$(basename "$candidate")
      break
    fi
  done
  [ -n "$wayland_socket" ] && break
  if ! kill -0 "$compositor_pid" 2>/dev/null; then
    cat "$proof_directory/sway.log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done
if [ -z "$wayland_socket" ]; then
  echo "Disposable Wayland compositor did not become ready." >&2
  cat "$proof_directory/sway.log" >&2
  exit 1
fi

XDG_RUNTIME_DIR="$proof_directory/run" WAYLAND_DISPLAY="$wayland_socket" \
  CRABFLEET_TEST_WAYLAND=1 \
  go test -race ./cmd/crabfleet-connect -run '^TestWaylandLive' -v -count=1
