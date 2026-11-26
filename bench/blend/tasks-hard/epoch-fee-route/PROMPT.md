# Quote an exact two-leg Token-2022 fee route

Repair the existing implementation of `solve(input)` in this small offline Node 22 package. Preserve the API; edit the implementation modules, not tests. No packages, network, RPC, filesystem or clock are needed. Several modules contain interacting defects. The intended fix is compact; do not replace the package with a large framework.

Input is {epoch,net,first,second}; each fee schedule is {at,old:{bps,max},next:{bps,max}}. Select next at epoch >= at. A leg charges min(max, ceil(gross*bps/10000)); zero gross costs zero. Find the SMALLEST u64 gross whose net after first and then second fees is at least the requested net. Return {gross,firstFee,secondFee,net} for that gross (actual net, not the requested value). Return invalid if impossible, including two-leg u64 overflow/unreachable output. All schedule fields must be validated even when inactive. Do not convert amounts to Number or scan token-by-token. The two schedules may cross epochs independently.

All byte strings are canonical lowercase even-length hex. Unsigned token/lamport amounts are canonical decimal strings in [0, 2^64-1]. Indices/epochs are nonnegative safe integers unless a narrower bound is stated. Reject malformed/out-of-range inputs with exactly `{error:"invalid"}`; never mutate input, even on failure. Successful BigInt values are returned as decimal strings by the existing entrypoint. Do not silently coerce numeric strings or repair malformed wire data.

Run `node --test visible.test.ts`. Hidden tests also cover coupled invariants and boundaries; passing the public examples alone is not the contract.
