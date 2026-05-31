<!-- dht-sim (reference simulator). Quick checklist before merge. -->

## Summary

<!-- What changed and why. -->

## Checklist

- [ ] **Security-relevant change?** If this changes anything about *what the protocol protects* (rare here — usually the simulator only re-vendors), add/update an entry in [`axona-docs/SECURITY-CHANGELOG.md`](https://github.com/axona-net/axona-docs/blob/main/SECURITY-CHANGELOG.md). Resolved items only; **never enumerate still-open findings**.
- [ ] Kernel re-vendored via `./scripts/sync-vendor-kernel.sh` if pulling a new `@axona/protocol` (verify the vendored `KERNEL_VERSION`).
- [ ] In-sim regression suite passes.
