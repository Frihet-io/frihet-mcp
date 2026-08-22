/**
 * Exact external harness versions for the Phase 0 baseline (issue #1578).
 *
 * Pinned here rather than in package.json devDependencies on purpose: the
 * Inspector pulls ~96 packages of build tooling (vite, react) that nothing else
 * in this repo needs, and the conformance framework is explicitly marked
 * unstable upstream. Both are invoked through `npx --yes <pkg>@<exact>`, and the
 * version that actually ran is recorded into the baseline, so a drift between
 * this file and the artifact is visible rather than assumed.
 */
export const CONFORMANCE_VERSION = "0.1.16";
export const INSPECTOR_VERSION = "2.3.0";
export const CONFORMANCE_PKG = "@modelcontextprotocol/conformance";
export const INSPECTOR_PKG = "@modelcontextprotocol/inspector";
