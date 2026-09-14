#!/bin/sh
set -eu
for dependency in go pulseaudio pactl ffmpeg; do
  command -v "$dependency" >/dev/null 2>&1 || { echo "Missing $dependency" >&2; exit 1; }
done
cd "$(dirname "$0")/.."
proof_directory=$(mktemp -d /tmp/cfa.XXXXXX)
audio_pid=
cleanup() {
  if [ -n "$audio_pid" ]; then
    kill "$audio_pid" 2>/dev/null || true
    wait "$audio_pid" 2>/dev/null || true
  fi
  rm -rf "$proof_directory"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
mkdir -m 700 "$proof_directory/run" "$proof_directory/config" "$proof_directory/state"
cat > "$proof_directory/pulse.conf" <<EOF_PULSE
load-module module-native-protocol-unix socket=$proof_directory/run/socket auth-anonymous=1
load-module module-null-sink sink_name=crabfleet_fixture channels=2 rate=48000
set-default-sink crabfleet_fixture
EOF_PULSE
# The socket is accessible only to this user inside the private test directory.
# No physical sink, source, microphone, or active desktop audio server is loaded.
XDG_RUNTIME_DIR="$proof_directory/run" XDG_CONFIG_HOME="$proof_directory/config" \
  PULSE_STATE_PATH="$proof_directory/state" \
  pulseaudio --daemonize=no --exit-idle-time=-1 --use-pid-file=no --disable-shm \
  -nF "$proof_directory/pulse.conf" > "$proof_directory/audio.log" 2>&1 &
audio_pid=$!
attempt=0
while [ ! -S "$proof_directory/run/socket" ]; do
  if ! kill -0 "$audio_pid" 2>/dev/null || [ "$attempt" -ge 100 ]; then
    cat "$proof_directory/audio.log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done
PULSE_SERVER="unix:$proof_directory/run/socket" XDG_RUNTIME_DIR="$proof_directory/run" \
  CRABFLEET_TEST_AUDIO=1 \
  go test -race ./internal/connect -run '^TestPulseAudioLiveOutputMonitor$' -v -count=1
