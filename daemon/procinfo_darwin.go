//go:build darwin

package main

import (
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

// macOS answers the same three questions as procinfo_linux.go, but with none
// of the same primitives: there is no SO_PEERCRED, and no /proc to read a
// start time or a parent out of. Peer credentials come from two separate
// socket options, and the process table comes from a sysctl.

func agentPeerCredentials(connection net.Conn) (int, int, error) {
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return 0, 0, fmt.Errorf("agent socket is not a Unix connection")
	}
	raw, err := unixConnection.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var (
		pid, uid   int
		controlErr error
	)
	// LOCAL_PEERCRED carries the uid but not the pid, and LOCAL_PEERPID the
	// pid but not the uid, so both are required to get what SO_PEERCRED
	// returns in one call on Linux.
	err = raw.Control(func(fd uintptr) {
		credentials, credErr := unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		if credErr != nil {
			controlErr = credErr
			return
		}
		peerPID, pidErr := unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
		if pidErr != nil {
			controlErr = pidErr
			return
		}
		uid, pid = int(credentials.Uid), peerPID
	})
	if err != nil {
		return 0, 0, err
	}
	if controlErr != nil {
		return 0, 0, controlErr
	}
	return pid, uid, nil
}

// processStartTime returns the process's start time in microseconds since the
// epoch. The unit differs from Linux's clock ticks since boot on purpose: the
// value is only ever compared against another reading of the same pid, so it
// has to be stable for the life of the process and differ across a pid reuse,
// and nothing more.
func processStartTime(pid int) (uint64, error) {
	process, err := processInfo(pid)
	if err != nil {
		return 0, err
	}
	started := process.Proc.P_starttime
	return uint64(started.Sec)*1_000_000 + uint64(started.Usec), nil
}

func processParentPID(pid int) (int, error) {
	process, err := processInfo(pid)
	if err != nil {
		return 0, err
	}
	return int(process.Eproc.Ppid), nil
}

func processInfo(pid int) (*unix.KinfoProc, error) {
	process, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return nil, fmt.Errorf("read process %d: %w", pid, err)
	}
	if process == nil {
		return nil, fmt.Errorf("no such process %d", pid)
	}
	return process, nil
}
