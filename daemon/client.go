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

func (d *Daemon) wireLoop(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := d.wireSession(ctx)
		if ctx.Err() != nil {
			return
		}
		d.setLastError(err)
		d.logf("wire disconnected: %v", err)
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

func (d *Daemon) wireSession(ctx context.Context) error {
	endpoint, err := wireURL(d.cfg.URL)
	if err != nil {
		return err
	}
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer "+d.token)
	connection, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPHeader: headers})
	if err != nil {
		return err
	}
	defer connection.Close(websocket.StatusNormalClosure, "daemon session ended")
	connection.SetReadLimit(maxWireFrameBytes)
	wire := newWireConnection(connection)
	if err := wire.write(ctx, WireFrame{
		T: "hello", Proto: wireProtocol, DaemonVer: buildVersion(), Host: d.cfg.Host,
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

	d.setConnection(wire)
	d.setLastError(nil)
	defer d.setConnection(nil)
	d.logf("connected as %s (%s)", d.cfg.Host, hello.HostID)
	if err := d.sendRoster(ctx); err != nil {
		return err
	}
	d.notifyOutbox()

	heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
	defer stopHeartbeat()
	go d.heartbeatLoop(heartbeatCtx, wire)
	return d.readWire(ctx, connection, wire)
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

func (d *Daemon) readWire(ctx context.Context, connection *websocket.Conn, writer *wireConnection) error {
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
			go d.handleIncoming(ctx, writer, frame)
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

func (d *Daemon) handleIncoming(ctx context.Context, connection *wireConnection, frame WireFrame) {
	code, retryable, err := d.deliver(ctx, frame)
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

func (d *Daemon) outboxLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-d.kickOutbox:
		}
		for ctx.Err() == nil && d.currentConnection() != nil {
			worked, err := d.flushOne(ctx)
			if err != nil {
				d.logf("flush outbox: %v", err)
				break
			}
			if !worked {
				break
			}
		}
	}
}

func (d *Daemon) flushOne(ctx context.Context) (bool, error) {
	claim, err := d.store.Claim(time.Now())
	if err != nil || claim == nil {
		return false, err
	}
	connection := d.currentConnection()
	if connection == nil {
		_ = d.store.Release(claim, "offline")
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
		_ = d.store.Release(claim, err.Error())
		return false, err
	}
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case outcome := <-waiter:
		if outcome.Err != nil {
			_ = d.store.Release(claim, outcome.Err.Error())
			return true, outcome.Err
		}
		if outcome.Code == "" {
			return true, d.store.Ack(claim)
		}
		if permanentSendNak(outcome.Code) {
			if err := d.store.Kill(claim, outcome.Code); err != nil {
				return true, err
			}
			d.bounce(ctx, claim.Message, outcome.Code)
			return true, nil
		}
		return true, d.store.Release(claim, outcome.Code)
	case <-timer.C:
		return true, d.store.Release(claim, "send ack timeout")
	case <-ctx.Done():
		return false, d.store.Release(claim, ctx.Err().Error())
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
