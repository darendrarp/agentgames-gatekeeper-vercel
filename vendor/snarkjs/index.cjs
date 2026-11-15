// Local snarkjs 0.7.6 shim for the CrossEyed client-side ZK flow.
// npm install fails in this VM (sandbox EPERM), so instead of the npm
// package we load the published UMD browser bundle (build/snarkjs.min.js),
// verified byte-identical on jsDelivr and unpkg, and export it as the
// `snarkjs` module the site's client-zk-node.mjs helper requires.
// The bundle is a plain script (`var snarkjs = ...`), so require() alone
// returns {} — wrapping it in a Function body lets us return the object.
// VENDORED COPY for the Vercel package (~/workspace/agentgames/vercel/).
// Identical to the CrossEyed shim except the bundle path, which is
// relative to this file (snarkjs.min.js sits next to it).
const fs = require('fs');
const path = require('path');
const bundlePath = path.join(__dirname, 'snarkjs.min.js');
const code = fs.readFileSync(bundlePath, 'utf8');
const snarkjs = new Function(code + '\n;return snarkjs;')();
if (!snarkjs || typeof snarkjs.groth16 !== 'object' || typeof snarkjs.groth16.fullProve !== 'function') {
  throw new Error('SNARKJS_BUNDLE_LOAD_FAILED');
}
module.exports = snarkjs;
