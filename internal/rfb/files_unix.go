//go:build !windows

package rfb

import "syscall"

const fileNonblock = syscall.O_NONBLOCK
