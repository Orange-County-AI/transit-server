import { describe, expect, it } from "vitest";
import { AddressError, formatAgentAddress, formatRoomAddress, parseAddress } from "../../src/lib/transit/addr";
import { hmacSign, hmacVerify, openSecret, sealSecret, sha256hex } from "../../src/lib/transit/crypto";
import { dlvId, enrollCode, hostId, intId, txId } from "../../src/lib/transit/ids";
import { TokenBucket } from "../../src/lib/transit/token-bucket";
import { MAX_WIRE_FRAME_BYTES, WireError, decodeDaemonFrame, decodeWorkerFrame } from "../../src/lib/transit/wire";

describe("Transit identifiers", () => {
  it("uses the protocol prefixes and 12 lowercase hex digits", () => {
    expect(txId()).toMatch(/^tx_[0-9a-f]{12}$/);
    expect(dlvId()).toMatch(/^dlv_[0-9a-f]{12}$/);
    expect(hostId()).toMatch(/^hst_[0-9a-f]{12}$/);
    expect(intId()).toMatch(/^int_[0-9a-f]{12}$/);
  });

  it("renders enrollment codes from the unambiguous alphabet", () => {
    for (let index = 0; index < 100; index += 1) {
      expect(enrollCode()).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{4}$/);
    }
  });
});

describe("Transit addresses", () => {
  it("formats and parses agent and room addresses", () => {
    expect(formatAgentAddress("alice", "alpha")).toBe("alice@alpha");
    expect(parseAddress("alice@alpha")).toEqual({
      kind: "agent",
      name: "alice",
      host: "alpha",
      address: "alice@alpha",
    });
    expect(formatAgentAddress("fitty", "52labs")).toBe("fitty@52labs");
    expect(parseAddress("fitty@52labs")).toEqual({
      kind: "agent",
      name: "fitty",
      host: "52labs",
      address: "fitty@52labs",
    });
    expect(formatAgentAddress("bob", "beta", "partner-org")).toBe(
      "partner-org/bob@beta",
    );
    expect(parseAddress("partner-org/bob@beta")).toEqual({
      kind: "agent",
      name: "bob",
      host: "beta",
      organization: "partner-org",
      address: "partner-org/bob@beta",
    });
    expect(formatRoomAddress("ops")).toBe("#ops");
    expect(parseAddress("#ops")).toEqual({ kind: "room", room: "ops", address: "#ops" });
    expect(formatRoomAddress("ops", "partner-org")).toBe("partner-org/#ops");
    expect(parseAddress("partner-org/#ops")).toEqual({
      kind: "room",
      room: "ops",
      organization: "partner-org",
      address: "partner-org/#ops",
    });
  });

  it("rejects invalid and reserved names", () => {
    expect(() => parseAddress("operator@alpha")).toThrowError(AddressError);
    expect(() => parseAddress("alice@transit")).toThrowError(AddressError);
    expect(() => parseAddress("#Not-Lowercase")).toThrowError(AddressError);
    expect(() => parseAddress("missing-host")).toThrowError(AddressError);
    expect(() => parseAddress("Partner/bob@beta")).toThrowError(AddressError);
    expect(() => parseAddress("Partner/#ops")).toThrowError(AddressError);
    expect(() => parseAddress("partner-org/#Ops")).toThrowError(AddressError);
    expect(() => parseAddress("partner-org/#transit")).toThrowError(AddressError);
    expect(() => parseAddress("partner-org/#")).toThrowError(AddressError);
    expect(() => parseAddress("one/two/#ops")).toThrowError(AddressError);
    expect(() => parseAddress("one/two/bob@beta")).toThrowError(AddressError);
  });
});

describe("Transit cryptography", () => {
  const masterKey = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)));

  it("round-trips and authenticates sealed secrets", async () => {
    const sealed = await sealSecret("bot-token", masterKey);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9+/]+=*\.[A-Za-z0-9+/]+=*$/);
    expect(await openSecret(sealed, masterKey)).toBe("bot-token");
    await expect(openSecret(`${sealed.slice(0, -1)}A`, masterKey)).rejects.toThrow();
  });

  it("matches SHA-256 and HMAC-SHA256 vectors", async () => {
    expect(await sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const signature = await hmacSign("key", "The quick brown fox jumps over the lazy dog");
    expect(signature).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    expect(await hmacVerify("key", "The quick brown fox jumps over the lazy dog", signature)).toBe(true);
    expect(await hmacVerify("key", "tampered", signature)).toBe(false);
    expect(await hmacVerify("key", "value", "not-hex")).toBe(false);
  });
});

describe("transit-wire/1", () => {
  it("validates known daemon and Worker frames", () => {
    expect(decodeDaemonFrame('{"t":"hello","proto":1,"daemon_ver":"0.1.0","host":"alpha"}')).toEqual({
      t: "hello",
      proto: 1,
      daemon_ver: "0.1.0",
      host: "alpha",
    });
    expect(decodeWorkerFrame('{"t":"send_nak","id":"tx_001122334455","code":"no_route"}')).toEqual({
      t: "send_nak",
      id: "tx_001122334455",
      code: "no_route",
    });
    expect(
      decodeDaemonFrame('{"t":"deliver_ack","id":"dlv_001122334455","agent":"alice"}'),
    ).toEqual({ t: "deliver_ack", id: "dlv_001122334455", agent: "alice" });
    expect(
      decodeDaemonFrame(
        '{"t":"deliver_nak","id":"dlv_001122334455","agent":"alice","code":"agent_prompt_failed","retryable":true}',
      ),
    ).toEqual({
      t: "deliver_nak",
      id: "dlv_001122334455",
      agent: "alice",
      code: "agent_prompt_failed",
      retryable: true,
    });
    // A host whose last agent exited sends a roster with no agents, and Go's
    // `omitempty` drops the field rather than encoding `[]`. Treating that as
    // malformed closed the host's socket with 4002 and took the whole workspace
    // offline, so an absent roster decodes as a roster of none.
    expect(decodeDaemonFrame('{"t":"roster"}')).toEqual({ t: "roster", agents: [] });
    expect(decodeDaemonFrame('{"t":"roster","agents":[]}')).toEqual({ t: "roster", agents: [] });
    // A present but non-array agents field is still malformed.
    expect(() => decodeDaemonFrame('{"t":"roster","agents":"alice"}')).toThrow(WireError);
    // A newer daemon's unrecognized provenance degrades to a label, never to a
    // closed connection: `named_by: "herdr"` once 4002'd a host off the wire and
    // took every agent on it down with the frame.
    expect(
      decodeDaemonFrame(
        '{"t":"roster","agents":[{"name":"alice","kind":"omp","pane_id":"w1:p1","status":"idle","cwd":"/tmp","title":"t","named_by":"herdr"}]}',
      ),
    ).toEqual({
      t: "roster",
      agents: [
        {
          name: "alice",
          kind: "omp",
          pane_id: "w1:p1",
          status: "idle",
          cwd: "/tmp",
          title: "t",
          named_by: "user",
        },
      ],
    });
    // A structurally broken agent is still rejected.
    expect(() => decodeDaemonFrame('{"t":"roster","agents":[{"name":"alice"}]}')).toThrow(WireError);
    // An older daemon omits the agent echo; the frame must still decode.
    expect(decodeDaemonFrame('{"t":"deliver_ack","id":"dlv_001122334455"}')).toEqual({
      t: "deliver_ack",
      id: "dlv_001122334455",
    });
  });

  it("ignores unknown frame types but rejects malformed known frames", () => {
    expect(decodeDaemonFrame('{"t":"future","value":1}')).toBeNull();
    expect(() => decodeDaemonFrame('{"t":"hello","proto":2,"daemon_ver":"x","host":"alpha"}')).toThrowError(WireError);
    expect(() => decodeWorkerFrame('{"t":"send_nak","id":"x","code":"future"}')).toThrowError(WireError);
  });

  it("rejects frames over 1 MiB", () => {
    const oversized = JSON.stringify({ t: "future", body: "x".repeat(MAX_WIRE_FRAME_BYTES) });
    expect(() => decodeDaemonFrame(oversized)).toThrowError(
      expect.objectContaining({ code: "frame_too_large" }),
    );
  });
});

describe("token buckets", () => {
  it("enforces burst capacity and refills at the configured rate", () => {
    const bucket = new TokenBucket(10, 3, 1_000);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(1_000)).toBe(false);
    expect(bucket.take(1_100)).toBe(true);
    expect(bucket.take(1_100)).toBe(false);
  });
});
