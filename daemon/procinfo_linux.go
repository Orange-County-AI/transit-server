//go:build linux

package main

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// The daemon pins an adapter to the exact process that connected, so a pid
// alone is never enough: pids are reused, and a reused pid would let a new
// process inherit a dead agent's identity. Every platform therefore has to
// answer three questions -- who is on the other end of this socket, when did
// that process start, and who is its parent -- and each answers them with its
// own syscalls. See procinfo_darwin.go for the other half.

func agentPeerCredentials(connection net.Conn) (int, int, error) {
	unixConnection, ok := connection.(*net.UnixConn)
	if !ok {
		return 0, 0, fmt.Errorf("agent socket is not a Unix connection")
	}
	raw, err := unixConnection.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var credentials *syscall.Ucred
	var controlErr error
	err = raw.Control(func(fd uintptr) {
		credentials, controlErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return 0, 0, err
	}
	if controlErr != nil || credentials == nil {
		return 0, 0, controlErr
	}
	return int(credentials.Pid), int(credentials.Uid), nil
}

// processStartTime returns the process's start time in clock ticks since boot.
// The value is only ever compared against another reading of the same pid, so
// the unit does not have to match any other platform's -- only be stable for
// the life of the process and differ across a pid reuse.
func processStartTime(pid int) (uint64, error) {
	fields, err := processStatFields(pid)
	if err != nil {
		return 0, err
	}
	if len(fields) < 20 {
		return 0, fmt.Errorf("short /proc/%d/stat", pid)
	}
	start, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse /proc/%d start time: %w", pid, err)
	}
	return start, nil
}

func processParentPID(pid int) (int, error) {
	fields, err := processStatFields(pid)
	if err != nil {
		return 0, err
	}
	if len(fields) < 2 {
		return 0, fmt.Errorf("short /proc/%d/stat", pid)
	}
	parent, err := strconv.Atoi(fields[1])
	if err != nil {
		return 0, fmt.Errorf("parse /proc/%d parent pid: %w", pid, err)
	}
	return parent, nil
}

// processStatFields splits /proc/<pid>/stat after the comm field. comm is
// wrapped in parentheses and may itself contain spaces and parentheses, so the
// split has to start at the LAST ")" rather than tokenising the whole line.
func processStatFields(pid int) ([]string, error) {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return nil, err
	}
	rest := string(data)
	index := strings.LastIndex(rest, ")")
	if index < 0 {
		return nil, fmt.Errorf("invalid /proc/%d/stat", pid)
	}
	return strings.Fields(rest[index+1:]), nil
}
