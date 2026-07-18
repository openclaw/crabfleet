//go:build windows

package connect

func NewPlatformBackend(string) (Backend, error) {
	return NewWindowsBackend()
}
