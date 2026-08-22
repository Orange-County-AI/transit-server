# Transit OMP and Pi extension

This in-process extension connects OMP and standalone Pi sessions to the local Transit daemon over `agent.sock`. If the daemon is unavailable at session start, the extension reconnects with a bounded 1–30 second backoff.

## Install in OMP

Install from this Transit checkout into OMP's user extension directory:

```sh
mkdir -p ~/.omp/agent/extensions
cp -R daemon/contrib/omp-extension ~/.omp/agent/extensions/transit
```

OMP automatically discovers `~/.omp/agent/extensions/transit/package.json`. Its `omp.extensions` manifest enables `index.js`, so no setting or command-line flag is needed. Start a new OMP session after copying it.

For one repository only, copy the same package to the project extension directory instead:

```sh
mkdir -p .omp/extensions
cp -R daemon/contrib/omp-extension .omp/extensions/transit
```

## Install in Pi

Install this directory as a Pi package from the Transit checkout:

```sh
pi install ./daemon/contrib/omp-extension
```

The package's `pi.extensions` manifest loads `pi.js`. Use `pi install -l ./daemon/contrib/omp-extension` for one repository. Start a new Pi session after installing it.

The extension connects to:

```text
${TRANSIT_DATA_DIR:-$HOME/.local/share/transit}/agent.sock
```

Set `TRANSIT_DATA_DIR` before launching OMP or Pi when the daemon uses a non-default data directory.

## Delivery behavior

A delivered Transit envelope is injected with the harness's `pi.sendUserMessage(envelope, { deliverAs: "steer" })`. The extension then records a `transit-delivery-receipt` custom session entry and acknowledges the delivery only after that write completes. On a resumed session, existing receipt entries are rebuilt from the current session branch; a redelivery of one is acknowledged without reinjecting it.

## Test

No OMP or Pi installation is needed to run the socket-client tests:

```sh
bun test
```
