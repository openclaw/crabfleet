//go:build linux

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"strings"

	"github.com/openclaw/crabfleet/internal/connect"
	"github.com/openclaw/crabfleet/internal/connector"
	"github.com/openclaw/crabfleet/internal/rfb"
)

func platformBackendSelection(selected string) string {
	if selected == "wayland" {
		desktop := strings.ToLower(os.Getenv("XDG_CURRENT_DESKTOP"))
		if strings.Contains(desktop, "gnome") || strings.Contains(desktop, "kde") {
			return "portal"
		}
	}
	return selected
}
func configureFeatures(ctx context.Context, selected string, options *shareOptions, features featureOptions, stderr io.Writer) (func(), error) {
	var closers []io.Closer
	cleanup := func() {
		for i := len(closers) - 1; i >= 0; i-- {
			_ = closers[i].Close()
		}
	}
	fail := func(err error) (func(), error) { cleanup(); return nil, err }
	if features.video != "jpeg" && selected != "synthetic" {
		video, err := connect.NewFFmpegVideo(ctx, connect.VideoOptions{Encoder: features.encoder, Device: features.renderDevice, Report: func(message string) { fmt.Fprintln(stderr, message) }})
		if err != nil {
			if features.video != "auto" {
				return fail(err)
			}
			fmt.Fprintln(stderr, "ffmpeg unavailable; video uses JPEG.")
		} else {
			options.session.Video = selectedVideo{video, features.video}
			closers = append(closers, video)
		}
	}
	if features.audio {
		audio, err := connect.NewPulseAudio(ctx)
		if err != nil {
			return fail(err)
		}
		options.session.Audio = audio
	}
	options.clipboardEnabled = features.clipboard && selected != "synthetic"
	if options.clipboardEnabled && selected != "portal" {
		clipboard, err := connect.NewCommandClipboard(ctx, selected == "wayland")
		if err != nil {
			return fail(err)
		}
		options.session.Clipboard = clipboard
		closers = append(closers, clipboard)
	}
	if features.folder != "" {
		folder, err := rfb.OpenSharedFolder(features.folder, features.folderWrite)
		if err != nil {
			return fail(err)
		}
		options.session.SharedFolder = folder
		closers = append(closers, folder)
	}
	if features.fleet || selected == "portal" || options.quiet {
		directory := features.configDirectory
		if directory == "" {
			var err error
			directory, err = connector.DefaultDirectory()
			if err != nil {
				return fail(err)
			}
		}
		store, err := connector.OpenStore(directory)
		if err != nil {
			return fail(err)
		}
		closers = append(closers, store)
		state, err := store.Load()
		if err != nil {
			return fail(err)
		}
		current := &state
		if state.DirectPassword == "" {
			state.DirectPassword, err = generateSharePassword()
			if err != nil {
				return fail(err)
			}
			if err = store.Save(state); err != nil {
				return fail(err)
			}
		}
		options.password = state.DirectPassword
		if features.fleet {
			if state.Server == "" || state.AccessToken == "" {
				return fail(errors.New("sign in first with crabfleet-connect login --server <Fleet origin>"))
			}
			client, err := connector.NewClient(state.Server, state.AccessToken)
			if err != nil {
				return fail(err)
			}
			if features.advertise != "" {
				address, err := netip.ParseAddr(features.advertise)
				if err != nil || !netip.MustParsePrefix("100.64.0.0/10").Contains(address) {
					return fail(errors.New("advertise must be a Tailscale IPv4 address"))
				}
			}
			name := features.name
			if name == "" {
				name, _ = os.Hostname()
			}
			if name == "" {
				name = "Linux desktop"
			}
			pub := &connector.Publication{Client: client, Store: store, State: state, Host: connector.Host{Name: name, Address: features.advertise, Port: features.port, RelayOnly: features.advertise == ""}, Report: func(message string) { fmt.Fprintln(stderr, message) }}
			current = &pub.State
			options.publish = func(ctx context.Context, server *rfb.Server) error { return pub.Run(ctx, server.PublishRelay) }
		}
		options.portalRestore = current.RestoreToken
		options.savePortalRestore = func(token string) error { current.RestoreToken = token; return store.Save(*current) }
	}
	return cleanup, nil
}

type selectedVideo struct {
	connect.VideoEncoder
	codec string
}

func (v selectedVideo) Encode(ctx context.Context, frame connect.Frame, codec string) ([]byte, error) {
	if v.codec != "auto" && v.codec != codec {
		return nil, errors.New("codec disabled")
	}
	return v.VideoEncoder.Encode(ctx, frame, codec)
}

func servePortal(ctx context.Context, listener net.Listener, options shareOptions, password, name string, stdout io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	fmt.Fprintln(stdout, "Approve the monitor and device permissions in your desktop's sharing dialog.")
	backend, err := connect.NewPortal(ctx, connect.PortalOptions{AllMonitors: options.allMonitors, ViewOnly: options.viewOnly, Clipboard: options.clipboardEnabled, RestoreToken: options.portalRestore, SaveRestoreToken: options.savePortalRestore})
	if err != nil {
		return err
	}
	if options.clipboardEnabled {
		options.session.Clipboard = backend
	}
	go func() {
		select {
		case <-backend.Done():
			cancel()
		case <-ctx.Done():
		}
	}()
	err = serveBackend(ctx, listener, options, password, name, stdout, backend, "Linux desktop portal (PipeWire)")
	if backend.Err() != nil {
		return backend.Err()
	}
	return err
}
