/**
 * Provenance vs result, for the Phase 0 conformance artifacts.
 *
 * `run-phase0.mjs --check` re-runs the official harness and byte-compares the
 * output against the committed baseline. That is the right shape for a gate —
 * except the artifact also records WHICH COMMIT produced it, and a commit sha
 * changes on every commit. So the gate went red one commit after the baseline
 * landed and stayed red: #151 shipped a baseline captured at 298aa31 while the
 * PR head was a596338, which means `conformance:phase0:check` has never been
 * green on main since. A gate that cannot be green teaches everyone to ignore
 * it, which is how it stops being a gate.
 *
 * The fix is not to loosen the comparison. It is to say which fields are the
 * IDENTITY of the run and which are its RESULT, and compare only the result.
 *
 * Every entry below must be a field that changes when nothing about the
 * server's observable behaviour changed. `sdkVersion`, `protocolVersion`,
 * `conformanceVersion`, `inspectorVersion`, `nodeVersion`, the harness tarball
 * hashes, the inventory counts and the whole scenario matrix are deliberately
 * NOT here: each of those moving is a real signal that must turn the gate red.
 *
 * Widening this list is how a gate gets quietly defanged, so
 * `conformance-provenance.test.ts` pins it exactly and proves that masking
 * still catches a mutated result field.
 */

/** Dotted paths masked before comparison. Frozen: see the note above. */
export const PROVENANCE_POINTERS = Object.freeze([
  // `git rev-parse HEAD` at capture time. Pure identity: it is different on
  // every commit, including a commit that touches nothing the harness observes.
  "versions.serverSha",
]);

const PLACEHOLDER = "<provenance>";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Replace each provenance pointer with a placeholder.
 *
 * A pointer that does not resolve is left alone rather than created: the
 * comparison must not invent structure that the artifact does not have, or a
 * baseline that dropped `versions` entirely would still compare equal.
 */
export function maskProvenance(artifact, pointers = PROVENANCE_POINTERS) {
  const masked = clone(artifact);
  for (const pointer of pointers) {
    const segments = pointer.split(".");
    const leaf = segments.pop();
    let cursor = masked;
    for (const segment of segments) {
      if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) {
        cursor = null;
        break;
      }
      cursor = cursor[segment];
    }
    if (cursor && typeof cursor === "object" && leaf in cursor) {
      cursor[leaf] = PLACEHOLDER;
    }
  }
  return masked;
}

/** Read a dotted path, or undefined. */
export function readPointer(artifact, pointer) {
  return pointer.split(".").reduce(
    (cursor, segment) =>
      cursor && typeof cursor === "object" && segment in cursor ? cursor[segment] : undefined,
    artifact,
  );
}

/**
 * Compare a freshly captured artifact against the committed one, ignoring
 * provenance. Returns the observed/committed provenance values so the caller
 * can report what actually ran instead of silently discarding it.
 */
export function compareIgnoringProvenance(observed, committed) {
  const equal =
    JSON.stringify(maskProvenance(observed)) === JSON.stringify(maskProvenance(committed));
  return {
    equal,
    provenance: PROVENANCE_POINTERS.map((pointer) => ({
      pointer,
      observed: readPointer(observed, pointer),
      committed: readPointer(committed, pointer),
    })),
  };
}
