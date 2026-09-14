//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const serviceName = "crabfleet-connect.service"
const serviceMarker = "# Managed by crabfleet-connect service install\n"

func runService(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return errors.New("use service install [-- share options], start, stop, status, or uninstall")
	}
	command := args[0]
	if command != "install" && len(args) != 1 {
		return errors.New("unexpected service arguments")
	}
	switch command {
	case "start":
		var names []string
		for _, name := range []string{"DISPLAY", "WAYLAND_DISPLAY", "XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "PATH"} {
			if os.Getenv(name) != "" {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			if err := systemctl(ctx, stdout, stderr, append([]string{"import-environment"}, names...)...); err != nil {
				return err
			}
		}
		return systemctl(ctx, stdout, stderr, "start", serviceName)
	case "stop":
		return systemctl(ctx, stdout, stderr, "stop", serviceName)
	case "status":
		return systemctl(ctx, stdout, stderr, "status", "--no-pager", serviceName)
	case "install", "uninstall":
	default:
		return errors.New("unknown service command")
	}
	config, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	unit := filepath.Join(config, "systemd", "user", serviceName)
	autostart := filepath.Join(config, "autostart", "org.openclaw.CrabfleetConnect.desktop")
	if command == "uninstall" {
		for _, path := range []string{unit, autostart} {
			if err := checkManagedFile(path); err != nil {
				return err
			}
		}
		if err := systemctl(ctx, stdout, stderr, "disable", "--now", serviceName); err != nil {
			return err
		}
		for _, path := range []string{unit, autostart} {
			if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
				return err
			}
		}
		if err := systemctl(ctx, stdout, stderr, "daemon-reload"); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "Service and autostart removed. Account settings remain available for manual sharing.")
		return nil
	}
	shareArgs := args[1:]
	if len(shareArgs) > 0 && shareArgs[0] == "--" {
		shareArgs = shareArgs[1:]
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	if strings.HasPrefix(executable, filepath.Clean(os.TempDir())+string(os.PathSeparator)) {
		return errors.New("install the connector binary in a permanent location before installing its service")
	}
	unitBody, entry, err := serviceFiles(executable, shareArgs)
	if err != nil {
		return err
	}
	for _, path := range []string{unit, autostart} {
		if err := checkManagedFile(path); err != nil {
			return err
		}
	}
	if err := writeServiceFile(unit, unitBody); err != nil {
		return err
	}
	if err := writeServiceFile(autostart, entry); err != nil {
		return err
	}
	if err := systemctl(ctx, stdout, stderr, "daemon-reload"); err != nil {
		return err
	}
	if err := systemctl(ctx, stdout, stderr, "enable", serviceName); err != nil {
		return err
	}
	fmt.Fprintln(stdout, "Installed the user service and desktop autostart. Run crabfleet-connect service start to share now.")
	return nil
}
func serviceFiles(executable string, args []string) (string, string, error) {
	if !filepath.IsAbs(executable) {
		return "", "", errors.New("service executable must be absolute")
	}
	if err := runShare(context.Background(), args, io.Discard, io.Discard, true); err != nil {
		return "", "", fmt.Errorf("invalid service options: %w", err)
	}
	argv := append([]string{executable, "share"}, args...)
	argv = append(argv, "--quiet")
	var quoted []string
	for _, arg := range argv {
		q, err := systemdQuote(arg)
		if err != nil {
			return "", "", err
		}
		quoted = append(quoted, q)
	}
	unit := serviceMarker + "[Unit]\nDescription=Crabfleet Linux desktop connector\nPartOf=graphical-session.target\nAfter=graphical-session.target\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]\nType=simple\nExecStart=" + strings.Join(quoted, " ") + "\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=20\nKillMode=control-group\nUMask=0077\n\n[Install]\nWantedBy=graphical-session.target\n"
	// Desktop-entry Exec escaping is distinct from systemd's specifier syntax.
	if strings.ContainsAny(executable, "\n\r\x00") {
		return "", "", errors.New("invalid executable path")
	}
	escaped := strings.NewReplacer("\\", "\\\\\\\\", "\"", "\\\\\"", "`", "\\\\`", "$", "\\\\$", "%", "%%").Replace(executable)
	entry := serviceMarker + "[Desktop Entry]\nType=Application\nName=Crabfleet Connect\nComment=Share your desktop through Crabfleet\nExec=\"" + escaped + "\" service start\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
	return unit, entry, nil
}
func systemdQuote(value string) (string, error) {
	if strings.ContainsAny(value, "\n\r\x00") {
		return "", errors.New("service arguments must not contain control characters")
	}
	value = strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%", "$", "$$").Replace(value)
	return "\"" + value + "\"", nil
}
func checkManagedFile(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return fmt.Errorf("refusing to overwrite an unmanaged file at %s", path)
	}
	p, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(string(p), serviceMarker) {
		return fmt.Errorf("refusing to overwrite an unmanaged file at %s", path)
	}
	return nil
}
func writeServiceFile(path, body string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".crabfleet-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, err = file.WriteString(body); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
func systemctl(ctx context.Context, stdout, stderr io.Writer, args ...string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "systemctl", append([]string{"--user"}, args...)...)
	cmd.WaitDelay = time.Second
	cmd.Stdout, cmd.Stderr = stdout, stderr
	return cmd.Run()
}
