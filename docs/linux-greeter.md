---
title: Linux Login Screen
layout: default
permalink: /linux-greeter/
description: "Administrator-configured SDDM Wayland greeter sharing with a separate identity and authenticated access."
---

# Share an SDDM Wayland login screen

Crabfleet can wrap an administrator-configured **SDDM Wayland compositor** and
share its greeter using wayvnc. This is opt-in login-screen access: a remote
viewer still authenticates to Crabfleet, then signs into Linux through SDDM's
normal PAM and account policies. It does not bypass OS authentication or unlock
an existing session. Treat permission to control this share as physical-console
access, including the greeter's power and session controls.

This integration targets SDDM with Hyprland or another compositor compatible
with wayvnc 0.10+. It does not claim GDM, GNOME Shell, or arbitrary Wayland
greeter support. Portal sharing still requires a logged-in session. Distribution
versions, compositor capture/input protocols, and SDDM launch arrangements must
be validated on the administrator's machine.

## Prepare a separate greeter identity

Install `crabfleet-connect` in a permanent, root-owned executable location such
as `/usr/local/bin/crabfleet-connect`. Install wayvnc 0.10 or newer. Keep the
ordinary user's desktop service and its configuration separate from the greeter.
The greeter runs as SDDM's existing non-root account, usually `sddm`; the wrapper
does not create accounts, elevate privileges, or change account permissions.

An administrator can provision a private directory owned by that account:

```sh
sudo install -d -m 0700 -o sddm -g sddm /var/lib/sddm/crabfleet-greeter
```

For Fleet publication, explicitly approve **a separate connector login** using
that directory. Open the printed approval URL in the administrator's browser.
Do not copy the desktop user's `state.json`, browser profile, secret store, or
session environment into the greeter account.

```sh
sudo -u sddm /usr/local/bin/crabfleet-connect login \
  --config-dir /var/lib/sddm/crabfleet-greeter \
  --server https://fleet.example
```

This login creates its own desktop identity and Fleet credential. Fleet
authorization has the [same renewal and expiry rules](../linux-connector/) as
desktop sharing. An expired login prevents Fleet publication; the local OS
greeter remains usable. Omit `--fleet` for a direct-only share, which needs no
Fleet login. The direct password is generated and saved privately at first
startup. Retrieve it explicitly from the greeter's configuration when needed:

```sh
sudo -u sddm /usr/local/bin/crabfleet-connect password \
  --config-dir /var/lib/sddm/crabfleet-greeter
```

Neither the password nor connector/helper diagnostics are written to SDDM logs.
The wrapper reports only startup and shutdown status. A connector process being
started is not proof that capture or Fleet publication succeeded; verify the
actual connection as described below.

## Configure the compositor wrapper

First inspect the effective SDDM configuration, including distribution defaults
and `/etc/sddm.conf.d/`. Preserve the existing `CompositorCommand` and every one
of its arguments. Do not replace a working compositor configuration with a
generic template. The example below applies only when the original command is:

```text
start-hyprland -- --config /usr/share/sddm/hyprland.lua
```

Create a root-owned executable script at
`/usr/local/libexec/crabfleet-sddm-compositor` containing:

```sh
#!/bin/sh
exec /usr/local/bin/crabfleet-connect greeter \
  --user sddm \
  --config-dir /var/lib/sddm/crabfleet-greeter \
  --fleet --name 'Workstation login screen' --port 5901 \
  -- /usr/bin/start-hyprland -- --config /usr/share/sddm/hyprland.lua
```

Use the actual absolute compositor path on the host. The `--` separates wrapper
options from the compositor executable and its unchanged argument list. No
shell evaluation is performed on compositor arguments by the wrapper. If the
original compositor receives extra arguments from a display-manager launcher,
preserve those explicitly in the script using `"$@"` at the appropriate position.

Before installing an SDDM override, run the same invocation as the greeter with
`--check` added before `--`. It checks the account, private directory, saved
state, and executable availability, without starting a compositor or creating
credentials. It does not require a live greeter runtime directory:

```sh
sudo -u sddm /usr/local/bin/crabfleet-connect greeter --check \
  --user sddm --config-dir /var/lib/sddm/crabfleet-greeter --fleet \
  -- /usr/bin/start-hyprland -- --config /usr/share/sddm/hyprland.lua
```

After that passes, configure an administrator-owned SDDM drop-in, for example
`/etc/sddm.conf.d/90-crabfleet-greeter.conf`:

```ini
[General]
DisplayServer=wayland

[Wayland]
CompositorCommand=/usr/local/libexec/crabfleet-sddm-compositor
```

Ensure the script is executable and neither it nor its parent directory is
writable by the greeter or desktop user. Keep a copy of the previous effective
configuration and an independent administrator login, such as SSH or a text
console. Apply and test this change during an explicitly chosen logout or
maintenance window. Restarting SDDM can terminate all graphical sessions; the
connector never changes configuration or restarts the display manager for you.

## Runtime and connection boundaries

SDDM must supply a private, greeter-owned `XDG_RUNTIME_DIR`. The wrapper records
existing `wayland-*` sockets before starting the compositor, then waits up to
15 seconds for one newly created socket owned by the same greeter UID. It
rejects symlink sockets, public runtime directories, wrong ownership, and
ambiguous multiple new sockets. It never selects an inherited `WAYLAND_DISPLAY`
or an already-running desktop socket. `--socket-timeout` can adjust the startup
deadline up to two minutes.

The connector runs as the greeter account with that new socket, the explicit
Wayland backend, and the separate configuration directory. It uses the same
authenticated private wayvnc connection and VNC/Fleet authentication as ordinary
sharing. Clipboard, audio, and shared folders are disabled; JPEG/RAW video avoids
additional media dependencies. Use `--output` to select a compositor output if
the default is unsuitable.

Direct VNC listens only on `127.0.0.1`, by default port 5901 so it can coexist
with the desktop user's default port 5900. Use an SSH tunnel and the greeter's
VNC password, or use the independently authorized Fleet browser card:

```sh
ssh -N -L 5902:127.0.0.1:5901 administrator@linux-host
```

Connect a VNC viewer to `127.0.0.1:5902`. The greeter card remains a separate
desktop identity; there is no automatic handoff to the signed-in user's share.
When SDDM stops its greeter compositor, the wrapper terminates the connector
and its helpers, allowing normal Fleet publication cleanup. Cancellation also
stops both process groups, with a bounded grace period before forced cleanup.
Network failures retain the normal publication-recovery behavior. A missing
socket, invalid sharing configuration, or failed connector disables sharing
while leaving the original compositor and local OS login running. A compositor
failure is returned to SDDM.

## Verify and remove

In the chosen maintenance window, verify the local greeter still works, that a
wrong VNC password is rejected, and that an authorized remote viewer sees the
login screen. Sign in through SDDM normally and confirm the greeter share stops
when its compositor exits. Reconnect through the desktop user's separately
configured share. Verify logout creates a fresh greeter share without revealing
the previous user's desktop or changing its identity. Compositor compatibility
and that full SDDM/PAM lifecycle require this real-host acceptance check.

To remove the integration, remove only the Crabfleet SDDM override and restore
the previously recorded compositor command during another maintenance window.
Once greeter sharing has stopped, revoke its Fleet login with `logout
--config-dir /var/lib/sddm/crabfleet-greeter`. Preserve the ordinary user's
configuration. Remove the wrapper and dedicated greeter state only when no
longer needed.

Automated Linux tests use disposable compositor and connector processes and
synthetic Unix sockets. They cover argument preservation, existing-socket and
ownership rejection, helper failures, deadlines, cancellation, and descendant
cleanup. They do not capture a real greeter, enter OS credentials, or restart
SDDM, and are not evidence that an untested compositor version is compatible.
