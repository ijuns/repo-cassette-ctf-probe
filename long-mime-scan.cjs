module.exports = async function scan() {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const url = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`;
  const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId};
  const variants = [
    ['safe-control', 'application/json'],
    ['one-space-control', 'application/json '],
    ...[0, 1, 63, 127, 239, 240, 241, 255, 256, 511, 1023].map(n => [`nel-after-${n}-spaces`, 'application/json' + ' '.repeat(n) + '\u0085']),
    ...[0, 127, 255, 511].map(n => [`nel-before-${n}-spaces`, '\u0085' + ' '.repeat(n) + 'application/json']),
  ];
  for (const [label, mime] of variants) {
    const name = `long-mime-${label}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({...ids, name, version: 7, mime_type: mime}),
    });
    const data = await response.json().catch(() => ({}));
    console.log(`MIME ${label}: len=${Buffer.byteLength(mime)} status=${response.status} ok=${Boolean(data.ok)} error=${JSON.stringify(data.msg || null)}`);
    if (response.ok && data.ok) {
      // An accepted anomalous MIME would be a candidate. Do not disclose the signed URL.
      console.log(`ACCEPTED ${label}`);
    }
  }
};
