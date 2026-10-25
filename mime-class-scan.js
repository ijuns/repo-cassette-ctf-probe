module.exports = async function scan({context}) {
  const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
  const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url').toString('utf8'));
  const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
  const [, run, job] = scope.split(':');
  const ids = {workflow_run_backend_id: run, workflow_job_run_backend_id: job};
  const base = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/`;
  const cases = [
    'text/plain', 'text/html', 'text/markdown', 'application/javascript',
    'image/svg+xml', 'image/png', 'application/zip', 'application/pdf',
  ];
  const body = Buffer.from('{"probe":"mime-class"}');
  async function twirp(method, payload) {
    const r = await fetch(base + method, {
      method:'POST', headers:{Authorization:`Bearer ${runtimeToken}`, 'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    });
    return {status:r.status, data:await r.json().catch(() => ({}))};
  }
  for (let i=0;i<cases.length;i++) {
    const mime=cases[i], name=`mime-class-${context.runId}-${i}`;
    try {
      const created=await twirp('CreateArtifact',{...ids,name,version:7,mime_type:mime});
      const url=created.data.signed_upload_url || created.data.signedUploadUrl;
      if (!created.data.ok || !url) {
        console.log('MIME_CASE',JSON.stringify({mime,create:created.status,msg:created.data.msg||''}));
        continue;
      }
      const put=await fetch(url,{method:'PUT',headers:{'x-ms-blob-type':'BlockBlob','x-ms-blob-content-type':'application/json\u0085'},body});
      if (put.status!==201) throw new Error(`Blob PUT ${put.status}`);
      const final=await twirp('FinalizeArtifact',{...ids,name,size:String(body.length)});
      if (!final.data.ok) throw new Error(`Finalize ${final.status}`);
      const id=String(final.data.artifact_id || final.data.artifactId);
      const rest=await fetch(`https://api.github.com/repos/${context.repo.owner}/${context.repo.repo}/actions/artifacts/${id}/zip`,{
        redirect:'manual',headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github.v3+json'},
      });
      const location=rest.headers.get('location');
      const rsct=location ? new URL(location).searchParams.get('rsct') : null;
      const raw=location ? await fetch(location) : null;
      const ct=raw?.headers.get('content-type') || null;
      const actual=raw ? Buffer.from(await raw.arrayBuffer()) : null;
      console.log('MIME_CASE',JSON.stringify({mime,id,rest:rest.status,rsct,raw:raw?.status,ct,match:actual?.equals(body)}));
    } catch(e) {console.log('MIME_CASE',JSON.stringify({mime,error:String(e)}));}
  }
};
