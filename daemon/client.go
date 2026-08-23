package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

type wireConnection struct {
	conn *websocket.Conn
	mu   chan struct{}
}

func newWireConnection(connection *websocket.Conn) *wireConnection {
	mutex := make(chan struct{}, 1)
	mutex <- struct{}{}
	return &wireConnection{conn: connection, mu: mutex}
}

func (connection *wireConnection) write(ctx context.Context, frame WireFrame) error {
	data, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	if len(data) > maxWireFrameBytes {
		return fmt.Errorf("wire frame exceeds 1 MiB")
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-connection.mu:
	}
	defer func() { connection.mu <- struct{}{} }()
	writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return connection.conn.Write(writeCtx, websocket.MessageText, data)
}

func (d *Daemon) wireLoop(ctx context.Context, e *enrollmentRuntime) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := d.wireSession(ctx, e)
		if ctx.Err() != nil {
			return
		}
		e.setLastError(err)
		d.logf("wire disconnected (%s): %v", e.id, err)
		delay := jitter(backoff)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		backoff *= 2
		if backoff > 30*time.Second {
			backoff = 30 * time.Second
		}
	}
}

func jitter(base time.Duration) time.Duration {
	var value [1]byte
	if _, err := rand.Read(value[:]); err != nil {
		return base
	}
	factor := 0.8 + float64(value[0])/255*0.4
	return time.Duration(float64(base) * factor)
}

func (d *Daemon) wireSession(ctx context.Context, e *enrollmentRuntime) error {
	if e.token == "" || e.store == nil {
		return fmt.Errorf("enrollment %s is not usable", e.id)
	}
	endpoint, err := wireURL(e.url)
	if err != nil {
		return err
	}
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer "+e.token)
	connection, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		return err
	}
	defer connection.Close(websocket.StatusNormalClosure, "daemon session ended")
	connection.SetReadLimit(maxWireFrameBytes)
	wire := newWireConnection(connection)
	if err := wire.write(ctx, WireFrame{
		T: "hello", Proto: wireProtocol, DaemonVer: buildVersion(), Host: e.host,
	}); err != nil {
		return err
	}

	messageType, data, err := connection.Read(ctx)
	if err != nil {
		return err
	}
	if messageType != websocket.MessageText || len(data) > maxWireFrameBytes {
		return fmt.Errorf("invalid hello response")
	}
	var hello WireFrame
	if err := json.Unmarshal(data, &hello); err != nil {
		return err
	}
	if hello.T == "hello_err" {
		return fmt.Errorf("hello rejected: %s", hello.Code)
	}
	if hello.T != "hello_ok" || hello.HostID == "" || hello.Org == "" {
		return fmt.Errorf("unexpected hello response %q", hello.T)
	}

	e.setConnection(wire)
	e.setLastError(nil)
	defer e.setConnection(nil)
	d.logf("connected as %s (%s) for %s", e.host, hello.HostID, e.id)
	if err := d.sendRoster(ctx, e); err != nil {
		return err
	}
	e.notifyOutbox()

	heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
	defer stopHeartbeat()
	go d.heartbeatLoop(heartbeatCtx, wire)
	return d.readWire(ctx, e, connection, wire)
}

func (d *Daemon) heartbeatLoop(ctx context.Context, connection *wireConnection) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := connection.write(ctx, WireFrame{T: "pong"}); err != nil {
				return
			}
		}
	}
}

func (d *Daemon) readWire(ctx context.Context, e *enrollmentRuntime, connection *websocket.Conn, writer *wireConnection) error {
	for {
		messageType, data, err := connection.Read(ctx)
		if err != nil {
			return err
		}
		if messageType != websocket.MessageText || len(data) > maxWireFrameBytes {
			return fmt.Errorf("invalid wire frame")
		}
		var frame WireFrame
		if err := json.Unmarshal(data, &frame); err != nil {
			return fmt.Errorf("decode wire frame: %w", err)
		}
		switch frame.T {
		case "deliver":
			go d.handleIncoming(ctx, e, writer, frame)
		case "send_ack":
			d.resolveCommit(frame.ID, "", nil)
		case "send_nak":
			d.resolveCommit(frame.ID, frame.Code, nil)
		case "rpc_result":
			d.resolveRPC(frame.RID, RPCResponse{Result: frame.Result, Error: frame.Error})
		case "ping":
			// The daemon's periodic pong is the hibernation-safe heartbeat request;
			// this auto-response confirms the Worker-side socket is alive.
		default:
			// Unknown types are ignored for additive protocol evolution.
		}
	}
}

// handleIncoming answers on the connection the delivery arrived on, and
// resolves the target inside that connection's organization: the same agent
// name can exist in two of them.
func (d *Daemon) handleIncoming(ctx context.Context, e *enrollmentRuntime, connection *wireConnection, frame WireFrame) {
	code, retryable, err := d.deliver(ctx, e, frame)
	if err == nil {
		if writeErr := connection.write(ctx, WireFrame{
			T: "deliver_ack", ID: frame.ID, Agent: frame.Agent,
		}); writeErr != nil {
			d.logf("deliver ack %s: %v", frame.ID, writeErr)
		}
		return
	}
	if writeErr := connection.write(ctx, WireFrame{
		T: "deliver_nak", ID: frame.ID, Agent: frame.Agent,
		Code: code, Retryable: &retryable,
	}); writeErr != nil {
		d.logf("deliver nak %s: %v", frame.ID, writeErr)
	}
}

func (d *Daemon) outboxLoop(ctx context.Context, e *enrollmentRuntime) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-e.kickOutbox:
		}
		for ctx.Err() == nil && e.currentConnection() != nil {
			worked, err := d.flushOne(ctx, e)
			if err != nil {
				d.logf("flush outbox (%s): %v", e.id, err)
				break
			}
			if !worked {
				break
			}
		}
	}
}

func (d *Daemon) flushOne(ctx context.Context, e *enrollmentRuntime) (bool, error) {
	if e.store == nil {
		return false, nil
	}
	claim, err := e.store.Claim(time.Now())
	if err != nil || claim == nil {
		return false, err
	}
	connection := e.currentConnection()
	if connection == nil {
		_ = e.store.Release(claim, "offline")
		return false, nil
	}
	waiter := d.registerCommit(claim.Message.ID)
	defer d.removeCommit(claim.Message.ID, waiter)
	frame := WireFrame{
		T: "send", ID: claim.Message.ID, From: claim.Message.From, To: claim.Message.To,
		Body: claim.Message.Body, ReplyTo: claim.Message.ReplyTo,
		TS: claim.Message.TS.UTC().Format(time.RFC3339Nano),
	}
	if err := connection.write(ctx, frame); err != nil {
		_ = e.store.Release(claim, err.Error())
		return false, err
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case outcome := <-waiter:
		if outcome.Err != nil {
			_ = e.store.Release(claim, outcome.Err.Error())
			return true, outcome.Err
		}
		if outcome.Code == "" {
			return true, e.store.Ack(claim)
		}
		if permanentSendNak(outcome.Code) {
			if err := e.store.Kill(claim, outcome.Code); err != nil {
				return true, err
			}
			d.bounce(ctx, e, claim.Message, outcome.Code)
			return true, nil
		}
		return true, e.store.Release(claim, outcome.Code)
	case <-timer.C:
		return true, e.store.Release(claim, "send ack timeout")
	case <-ctx.Done():
		return false, e.store.Release(claim, ctx.Err().Error())
	}
}

func permanentSendNak(code string) bool {
	switch code {
	case "no_route", "not_member", "body_too_large", "reserved_name":
		return true
	default:
		return false
	}
}
