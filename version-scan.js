// Bounded probe of Actions artifact version parsing. Never print runtime tokens or signed URLs.
module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  if (!runtimeToken || !resultsUrl) throw new Error('Actions runtime variables unavailable');
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  if (!scope) throw new Error('Actions Results scope unavailable');
  const [, runId, jobId] = scope.split(':');
  const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId};
  const createUrl = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`;
  const finalizeUrl = createUrl.replace('/CreateArtifact', '/FinalizeArtifact');
  const weird = 'application/json\u0085';
  const safe = 'application/json';
  const stamp = `${Date.now()}-${context.runAttempt}`;

  function varint(value) {
    let n = BigInt(value);
    if (n < 0n) n = BigInt.asUintN(64, n);
    const out = [];
    while (n >= 128n) { out.push(Number((n & 127n) | 128n)); n >>= 7n; }
    out.push(Number(n));
    return Buffer.from(out);
  }
  function bytesField(number, value) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    return Buffer.concat([varint(BigInt(number * 8 + 2)), varint(BigInt(data.length)), data]);
  }
  function versionField(value) { return Buffer.concat([Buffer.from([0x28]), varint(value)]); }
  function binaryBody(name, versions, mime) {
    return Buffer.concat([
      bytesField(1, runId), bytesField(2, jobId), bytesField(3, name),
      ...versions.map(versionField), bytesField(6, bytesField(1, mime)),
    ]);
  }
  function jsonBody(name, versions, mime) {
    const prefix = JSON.stringify({...ids, name});
    return `${prefix.slice(0, -1)},${versions.map(v => `"version":${v}`).join(',')},"mime_type":${JSON.stringify(mime)}}`;
  }
  function readVarint(data, position) {
    let value = 0n, shift = 0n, p = position;
    for (let i = 0; i < 10; i++) {
      const byte = data[p++];
      if (byte === undefined) throw new Error('Truncated protobuf varint');
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return [value, p];
      shift += 7n;
    }
    throw new Error('Overlong protobuf varint');
  }
  function decodeCreate(data) {
    let p = 0, ok = false, signedUploadUrl = '';
    while (p < data.length) {
      const [tag, afterTag] = readVarint(data, p); p = afterTag;
      const field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (wire === 0) {
        const [value, afterValue] = readVarint(data, p); p = afterValue;
        if (field === 1) ok = value !== 0n;
      } else if (wire === 2) {
        const [length, afterLength] = readVarint(data, p); p = afterLength;
        const end = p + Number(length);
        if (end > data.length) throw new Error('Truncated protobuf field');
        if (field === 2) signedUploadUrl = data.subarray(p, end).toString('utf8');
        p = end;
      } else {
        throw new Error(`Unexpected response wire type ${wire}`);
      }
    }
    return {ok, signedUploadUrl};
  }
  async function create(label, format, body) {
    const response = await fetch(createUrl, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': format === 'binary' ? 'application/protobuf' : 'application/json'},
      body,
    });
    const raw = Buffer.from(await response.arrayBuffer());
    let data = {};
    if (response.ok) data = format === 'binary' ? decodeCreate(raw) : JSON.parse(raw.toString('utf8'));
    else {
      try { data = JSON.parse(raw.toString('utf8')); } catch { /* Non-JSON error. */ }
    }
    console.log(`${label}: create=${response.status} ok=${Boolean(data.ok)} error=${JSON.stringify(String(data.msg || data.message || '').slice(0, 140))}`);
    if (!response.ok || !data.ok || !data.signedUploadUrl && !data.signed_upload_url) return null;
    return data.signedUploadUrl || data.signed_upload_url;
  }
  async function finish(label, name, signedUploadUrl) {
    const body = Buffer.from(JSON.stringify({probe: label}), 'utf8');
    const upload = await fetch(signedUploadUrl, {
      method: 'PUT',
      headers: {'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05', 'x-ms-blob-type': 'BlockBlob'},
      body,
    });
    console.log(`${label}: upload=${upload.status}`);
    if (!upload.ok) return;
    const finalize = await fetch(finalizeUrl, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({...ids, name, size: String(body.length)}),
    });
    const result = await finalize.json().catch(() => ({}));
    const id = String(result.artifact_id || result.artifactId || '');
    console.log(`${label}: finalize=${finalize.status} ok=${Boolean(result.ok)} id=${/^\d+$/.test(id) ? id : 'none'}`);
    if (!finalize.ok || !result.ok || !/^\d+$/.test(id)) return;
    const download = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`, {
      redirect: 'manual',
      headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
    });
    const location = download.headers.get('location');
    const rsct = location ? new URL(location).searchParams.get('rsct') : null;
    console.log(`${label}: rest=${download.status} rsct=${JSON.stringify(rsct)}`);
  }

  const jsonCases = [
    ['j-v6-nel', ['6'], weird],
    ['j-v7-safe', ['7'], safe],
    ['j-neg1-nel', ['-1'], weird],
    ['j-minint-nel', ['-2147483648'], weird],
    ['j-maxint-nel', ['2147483647'], weird],
    ['j-uintmax-nel', ['4294967295'], weird],
    ['j-wrap6-nel', ['4294967302'], weird],
    ['j-wrap7-nel', ['4294967303'], weird],
    ['j-dupe6-7-nel', ['6', '7'], weird],
    ['j-dupe7-6-nel', ['7', '6'], weird],
    ['j-dupe6-7-safe', ['6', '7'], safe],
    ['j-dupe7-6-safe', ['7', '6'], safe],
  ];
  const binaryCases = [
    ['p-neg1-nel', [-1n], weird],
    ['p-wrap6-nel', [4294967302n], weird],
    ['p-wrap7-nel', [4294967303n], weird],
    ['p-dupe6-7-nel', [6n, 7n], weird],
    ['p-dupe7-6-nel', [7n, 6n], weird],
    ['p-dupe6-7-safe', [6n, 7n], safe],
    ['p-dupe7-6-safe', [7n, 6n], safe],
  ];
  for (const [label, versions, mime] of jsonCases) {
    const name = `${label}-${stamp}`;
    const url = await create(label, 'json', jsonBody(name, versions, mime));
    if (url) await finish(label, name, url);
  }
  for (const [label, versions, mime] of binaryCases) {
    const name = `${label}-${stamp}`;
    const url = await create(label, 'binary', binaryBody(name, versions, mime));
    if (url) await finish(label, name, url);
  }
};
