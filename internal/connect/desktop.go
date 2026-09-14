package connect

import (
	"context"
	"errors"
	"fmt"
	"slices"
)

const MaxScreens = 16

var (
	ErrResizeProhibited  = errors.New("desktop resizing is prohibited")
	ErrResizeUnsupported = errors.New("desktop resizing is unsupported")
)

// Screen describes one monitor in normalized framebuffer pixel coordinates.
type Screen struct {
	ID                  uint32
	X, Y, Width, Height int
	Flags               uint32
}

type DesktopLayout struct {
	Width, Height int
	Screens       []Screen
}

func (layout DesktopLayout) Validate() error {
	if layout.Width < 1 || layout.Height < 1 || layout.Width > MaxDimension || layout.Height > MaxDimension || int64(layout.Width)*int64(layout.Height)*4 > MaxFrameBytes {
		return errors.New("invalid desktop dimensions")
	}
	if len(layout.Screens) < 1 || len(layout.Screens) > MaxScreens {
		return errors.New("invalid desktop screen count")
	}
	ids := make(map[uint32]bool, len(layout.Screens))
	for _, screen := range layout.Screens {
		if ids[screen.ID] || screen.X < 0 || screen.Y < 0 || screen.Width < 1 || screen.Height < 1 || screen.X > layout.Width-screen.Width || screen.Y > layout.Height-screen.Height {
			return fmt.Errorf("invalid desktop screen %d", screen.ID)
		}
		ids[screen.ID] = true
	}
	return nil
}

func (layout DesktopLayout) Equal(other DesktopLayout) bool {
	return layout.Width == other.Width && layout.Height == other.Height && slices.Equal(layout.Screens, other.Screens)
}

func (frame Frame) DesktopLayout() DesktopLayout {
	screens := slices.Clone(frame.Screens)
	if len(screens) == 0 {
		screens = []Screen{{ID: 0, Width: frame.Width, Height: frame.Height}}
	}
	return DesktopLayout{Width: frame.Width, Height: frame.Height, Screens: screens}
}

// DesktopResizer changes real output modes only when the platform supports the
// requested layout. Session policy separately controls viewer authorization.
type DesktopResizer interface {
	DesktopResizeSupported() bool
	ResizeDesktop(context.Context, DesktopLayout) error
}
