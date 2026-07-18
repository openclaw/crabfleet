//go:build linux

package connect

func NewPlatformBackend(display string) (Backend, error) {
	return NewLinuxX11(display)
}
