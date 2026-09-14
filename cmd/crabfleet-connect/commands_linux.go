//go:build linux

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/openclaw/crabfleet/internal/connector"
)

func runPlatformCommand(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	command := args[0]
	if command == "service" {
		return runService(ctx, args[1:], stdout, stderr)
	}
	if command == "greeter" {
		return runGreeter(ctx, args[1:], stdout, stderr)
	}
	if command != "login" && command != "logout" && command != "status" && command != "doctor" && command != "password" {
		return fmt.Errorf("unknown command %q; use share, login, logout, status, doctor, password, service, or greeter", command)
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	directory := flags.String("config-dir", "", "connector configuration directory")
	server := flags.String("server", "", "Fleet origin for sign-in")
	if err := flags.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected command arguments")
	}
	if command == "doctor" {
		return doctor(stdout)
	}
	if *directory == "" {
		var err error
		*directory, err = connector.DefaultDirectory()
		if err != nil {
			return err
		}
	}
	if command == "status" || command == "password" {
		state, err := connector.ReadState(*directory)
		if err != nil {
			return err
		}
		if command == "password" {
			if state.DirectPassword == "" {
				return errors.New("no persistent share password exists; start sharing first")
			}
			fmt.Fprintln(stdout, state.DirectPassword)
			return nil
		}
		if state.AccessToken == "" {
			fmt.Fprintln(stdout, "Not signed in.")
			return nil
		}
		fmt.Fprintf(stdout, "Server: %s\nDesktop: %s\nAuthorization expires: %s\n", state.Server, state.HostID, time.UnixMilli(state.ExpiresAt).Format(time.RFC3339))
		if state.PublicationID != "" {
			fmt.Fprintln(stdout, "A Fleet publication is recorded; run service status to check the process.")
		}
		return nil
	}
	store, err := connector.OpenStore(*directory)
	if err != nil {
		return err
	}
	defer store.Close()
	state, err := store.Load()
	if err != nil {
		return err
	}
	if command == "logout" {
		stale := false
		if state.AccessToken != "" {
			client, err := connector.NewClient(state.Server, state.AccessToken)
			if err != nil {
				return err
			}
			publication := connector.Publication{Client: client, Store: store, State: state}
			if err := publication.Cleanup(ctx); err != nil {
				if !authorizationEnded(err) {
					return err
				}
				stale = true
				publication.State.PublicationID, publication.State.OwnershipToken = "", ""
			}
			if err := client.Logout(ctx); err != nil {
				if !authorizationEnded(err) {
					return err
				}
			}
			state = publication.State
		}
		state.Server, state.AccessToken = "", ""
		state.ExpiresAt = 0
		if err := store.Save(state); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "Signed out.")
		if stale {
			fmt.Fprintln(stdout, "Authorization had ended before cleanup; an inactive desktop registration may remain in Fleet.")
		}
		return nil
	}
	if *server == "" {
		return errors.New("login requires --server <Fleet origin>")
	}
	if state.AccessToken != "" {
		return errors.New("already signed in; stop sharing and log out before signing in again")
	}
	client, err := connector.NewClient(*server, "")
	if err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	device, err := client.StartLogin(ctx, "Crabfleet Connect ("+hostname+")")
	if err != nil {
		return err
	}
	fmt.Fprintf(stdout, "Open this address and approve the connector:\n%s\n", device.VerificationURI)
	if opener, err := exec.LookPath("xdg-open"); err == nil {
		openCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		cmd := exec.CommandContext(openCtx, opener, device.VerificationURI)
		cmd.WaitDelay = time.Second
		_ = cmd.Run()
		cancel()
	}
	auth, err := client.AwaitLogin(ctx, device)
	if err != nil {
		return err
	}
	client.Token = auth.AccessToken
	saved := false
	defer func() {
		if !saved {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = client.Logout(cleanup)
		}
	}()
	if err := client.Session(ctx); err != nil {
		return errors.New("Fleet did not grant connector publication permission; update the server and sign in again")
	}
	state.Server, state.AccessToken, state.ExpiresAt = client.Origin, auth.AccessToken, auth.ExpiresAt
	if err := store.Save(state); err != nil {
		return err
	}
	saved = true
	fmt.Fprintln(stdout, "Signed in. Start sharing with crabfleet-connect share --fleet.")
	return nil
}

func authorizationEnded(err error) bool {
	var api *connector.APIError
	return errors.As(err, &api) && (api.Status == 401 || api.Status == 403)
}
func doctor(out io.Writer) error {
	backend, err := resolveBackend("auto", "", "", false, "linux", os.Getenv("WAYLAND_DISPLAY"), os.Getenv("XDG_SESSION_TYPE"))
	if err != nil {
		return err
	}
	backend = platformBackendSelection(backend)
	fmt.Fprintf(out, "Selected backend: %s\n", backend)
	dependencies := []string{"ffmpeg", "pactl", "systemctl"}
	switch backend {
	case "portal":
		dependencies = append(dependencies, "gst-launch-1.0", "gst-inspect-1.0")
	case "wayland":
		dependencies = append(dependencies, "wayvnc", "wl-copy", "wl-paste")
	default:
		dependencies = append(dependencies, "xclip")
	}
	missing := false
	for _, name := range dependencies {
		if path, err := exec.LookPath(name); err == nil {
			fmt.Fprintf(out, "%s: %s\n", name, path)
		} else {
			fmt.Fprintf(out, "%s: missing\n", name)
			missing = true
		}
	}
	if backend == "portal" {
		fmt.Fprintln(out, "The desktop must provide RemoteDesktop, ScreenCast, and Clipboard portals. First use requires desktop approval.")
	}
	if missing {
		return errors.New("install the missing optional feature dependencies or disable those features")
	}
	return nil
}
