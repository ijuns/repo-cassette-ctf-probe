const crypto = require('node:crypto');

module.exports = async function lifecycleSelectiveProbe({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const resultsOrigin = new URL(process.env.ACTIONS_RESULTS_URL).origin;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(item => item.startsWith('Actions.Results:'));
  const [, workflowRunBackendId, workflowJobRunBackendId] = scope.split(':');
  const ids = {workflow_run_backend_id: workflowRunBackendId, workflow_job_run_backend_id: workflowJobRunBackendId};
  const service = `${resultsOrigin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const repo = `${context.repo.owner}/${context.repo.repo}`;
  const oddMime = '\u0085application/json';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function twirp(method, payload) {
    const response = await fetch(service + method, {
      method: 'POST',
      headers: {'Authorization': `Bearer ${runtimeToken}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
    });
    return {status: response.status, data: await response.json().catch(() => ({}))};
  }

  async function upload(url, body) {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-ms-version': '2025-01-05',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': oddMime,
      },
      body,
    });
    return response.status;
  }

  async function inspect(name, phase, finalResponses) {
    const listed = await twirp('ListArtifacts', {...ids, name_filter: name});
    const matches = (listed.data.artifacts || []).filter(item => item.name === name);
    const responseIds = finalResponses
      .filter(response => response.status === 200 && response.data.ok)
      .map(response => String(response.data.artifact_id || response.data.artifactId || ''));
    const listIds = matches.map(item => String(item.database_id || item.databaseId || ''));
    const artifactIds = [...new Set([...responseIds, ...listIds].filter(Boolean))];
    const results = [];
    for (const artifactId of artifactIds) {
      const rest = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
        redirect: 'manual',
        headers: {'Authorization': `Bearer ${process.env.GH_TOKEN}`, 'Accept': 'application/vnd.github.v3+json'},
      });
      const location = rest.headers.get('location');
      const rsct = location ? new URL(location).searchParams.get('rsct') : null;
      let raw = null;
      if (location) {
        const blob = await fetch(location);
        const bytes = Buffer.from(await blob.arrayBuffer());
        raw = {
          status: blob.status,
          type: blob.headers.get('content-type'),
          length: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          prefixHex: bytes.subarray(0, 8).toString('hex'),
          side: (() => { try { return JSON.parse(bytes.toString('utf8')).side || null; } catch { return null; } })(),
        };
      }
      results.push({artifactId, rest: rest.status, rsct, raw});
    }
    console.log('INSPECT', JSON.stringify({name, phase, listStatus: listed.status, artifactIds, results}));
    return results;
  }

  async function runCase({label, firstVersion, lateUpload}) {
    const name = `cassette-selective-${context.runId}-${label}`;
    const secondVersion = firstVersion === 6 ? 7 : 6;
    const createOrder = [firstVersion, secondVersion];
    const created = [];
    for (const version of createOrder) {
      const response = await twirp('CreateArtifact', {
        ...ids, name, version,
        mime_type: version === 6 ? oddMime : 'application/json',
      });
      created.push({version, response, url: response.data.signed_upload_url || response.data.signedUploadUrl});
    }
    console.log('CREATE', JSON.stringify({label, name, versions: createOrder, status: created.map(item => item.response.status), ok: created.map(item => Boolean(item.response.data.ok)), distinctBlobUrls: created[0].url !== created[1].url}));
    if (created.some(item => item.response.status !== 200 || !item.url)) return;

    const body = version => Buffer.from(JSON.stringify({probe:'selective-lifecycle', side:`v${version}`, label}));
    const onlySecond = await upload(created[1].url, body(secondVersion));
    console.log('UPLOAD', JSON.stringify({label, phase:'only-second', version:secondVersion, status:onlySecond}));
    if (onlySecond !== 201) return;

    const finalizePayload = {...ids, name, size: String(body(firstVersion).length)};
    const started = Date.now();
    const finalPromises = [twirp('FinalizeArtifact', finalizePayload), twirp('FinalizeArtifact', finalizePayload)];
    let firstUploadStatus = null;
    if (lateUpload) {
      await delay(4000);
      firstUploadStatus = await upload(created[0].url, body(firstVersion));
      console.log('UPLOAD', JSON.stringify({label, phase:'four-seconds-after-finalize-start', version:firstVersion, status:firstUploadStatus, elapsedMs:Date.now()-started}));
    }
    const settled = await Promise.allSettled(finalPromises);
    const finals = settled.map(item => item.status === 'fulfilled' ? item.value : {status:0, data:{}});
    console.log('FINALIZE', JSON.stringify({label, phase:'first-two', elapsedMs:Date.now()-started, status:finals.map(item => item.status), ok:finals.map(item => Boolean(item.data.ok)), ids:finals.map(item => String(item.data.artifact_id || item.data.artifactId || ''))}));
    await inspect(name, 'after-first-two', finals);

    if (!lateUpload) {
      firstUploadStatus = await upload(created[0].url, body(firstVersion));
      console.log('UPLOAD', JSON.stringify({label, phase:'after-missing-finalize', version:firstVersion, status:firstUploadStatus}));
    }
    if (firstUploadStatus === 201) {
      const recovery = await twirp('FinalizeArtifact', finalizePayload);
      console.log('FINALIZE', JSON.stringify({label, phase:'after-both-uploads', status:recovery.status, ok:Boolean(recovery.data.ok), id:String(recovery.data.artifact_id || recovery.data.artifactId || '')}));
      await inspect(name, 'after-both-uploads', [...finals, recovery]);
    }
  }

  for (const spec of [
    {label:'v6-first-missing', firstVersion:6, lateUpload:false},
    {label:'v7-first-missing', firstVersion:7, lateUpload:false},
    {label:'v6-first-late', firstVersion:6, lateUpload:true},
    {label:'v7-first-late', firstVersion:7, lateUpload:true},
  ]) {
    try { await runCase(spec); }
    catch (error) { console.log('CASE_ERROR', JSON.stringify({label:spec.label, errorName:error.name || 'Error'})); }
  }
};
