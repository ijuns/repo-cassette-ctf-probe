module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const endpoint = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId};
  const body = Buffer.from('{"hello":"test"}');
  const cases = [
    ['literal-nul', `nul-${Date.now()}\u0000.json`],
    ['percent-nul', `pct-${Date.now()}%00.json`],
  ];

  async function twirp(method, payload) {
    const response = await fetch(endpoint + method, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    return [response.status, await response.json().catch(() => ({}))];
  }

  for (const [label, name] of cases) {
    const [createStatus, created] = await twirp('CreateArtifact', {...ids, name, version: 7, mime_type: 'application/json'});
    console.log(`${label} Create HTTP ${createStatus}; ok=${Boolean(created.ok)}; msg=${JSON.stringify(created.msg || '')}`);
    if (createStatus !== 200 || !created.ok) continue;
    const uploadUrl = created.signed_upload_url || created.signedUploadUrl;
    const upload = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-ms-version': '2025-01-05',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': 'application/json\u0085',
      },
      body,
    });
    console.log(`${label} Azure PUT HTTP ${upload.status}`);
    if (!upload.ok) continue;
    const [finalStatus, finalized] = await twirp('FinalizeArtifact', {...ids, name, size: String(body.length)});
    console.log(`${label} Finalize HTTP ${finalStatus}; ok=${Boolean(finalized.ok)}`);
    if (finalStatus !== 200 || !finalized.ok) continue;
    const artifactId = String(finalized.artifact_id || finalized.artifactId);
    const githubUrl = `https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${artifactId}/zip`;
    const redirect = await fetch(githubUrl, {
      redirect: 'manual',
      headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
    });
    const location = redirect.headers.get('location');
    if (!location) {
      console.log(`${label} REST HTTP ${redirect.status}; Location missing`);
      continue;
    }
    const signed = new URL(location);
    const rsct = signed.searchParams.get('rsct');
    const rscd = signed.searchParams.get('rscd') || '';
    const raw = await fetch(location);
    console.log(`${label} REST HTTP ${redirect.status}; rsct=${JSON.stringify(rsct)}; rscdNul=${rscd.includes('\u0000')}; rscdPercent00=${rscd.toLowerCase().includes('%00')}; rawHTTP=${raw.status}; rawType=${JSON.stringify(raw.headers.get('content-type'))}`);
  }
};
