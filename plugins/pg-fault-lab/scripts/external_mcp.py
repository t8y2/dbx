#!/usr/bin/env python3
"""Real dbx-mcp subprocess integration against a private fixture store and PG17.

Arguments: --dbx PATH --mcp PATH --sidecar PATH --pg-bin DIR.
No production DSN/configuration, default profile, Docker daemon, or GUI is used.
The plugin is loaded as an unpacked development fixture through the real registry;
this does not test repository signatures or install into an existing user store.
"""
import argparse, base64, hashlib, json, os, pathlib, selectors, shutil, socket, sqlite3, subprocess, tempfile, time

parser=argparse.ArgumentParser()
for arg in ('dbx','mcp','sidecar','pg-bin'):parser.add_argument('--'+arg, required=True)
a=parser.parse_args(); source=pathlib.Path(__file__).resolve().parents[1]
for name in ('dbx','mcp','sidecar'):setattr(a,name,str(pathlib.Path(getattr(a,name)).resolve()))
a.pg_bin=str(pathlib.Path(a.pg_bin).resolve())

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

class MCP:
    def __init__(self,env,log):
        self.process=subprocess.Popen([a.mcp],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
        self.id=0
        self.call('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'pg-fault-external-fixture','version':'1'}})
        self.process.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');self.process.stdin.flush()
    def call(self,method,params):
        self.id+=1;id=self.id
        self.process.stdin.write(json.dumps({'jsonrpc':'2.0','id':id,'method':method,'params':params})+'\n');self.process.stdin.flush()
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            with selectors.DefaultSelector() as ready:
                ready.register(self.process.stdout,selectors.EVENT_READ)
                assert ready.select(max(0,deadline-time.monotonic())), 'MCP timeout: '+method
            line=self.process.stdout.readline()
            assert line, 'MCP exited: '+method
            result=json.loads(line)
            if result.get('id')!=id:continue
            assert 'error' not in result,result
            return result['result']
        raise AssertionError('MCP response deadline')
    def tool(self,name,arguments={}):return self.call('tools/call',{'name':name,'arguments':arguments})
    def close(self):
        if self.process.poll() is not None:return
        self.process.stdin.close()
        try:self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:self.process.kill();self.process.wait()

def content(result):
    assert not result.get('isError'),result
    return json.loads(next(x['text'] for x in result['content'] if x['type']=='text'))

with tempfile.TemporaryDirectory(prefix='dbx-external-pg-lab-') as temp:
    root=pathlib.Path(temp); store=root/'store';store.mkdir()
    env={'PATH':a.pg_bin+':/usr/bin:/bin','HOME':temp,'XDG_CONFIG_HOME':temp,'XDG_DATA_HOME':temp,'APPDATA':temp,'DBX_DATA_DIR':str(store),'LANG':'C.UTF-8','TZ':'UTC','PGPASSFILE':str(root/'absent'),'PGSERVICEFILE':str(root/'absent')}
    key=root/'fixture.key';key.write_bytes(base64.b64encode(os.urandom(32)));key.chmod(0o600);env['DBX_SECRET_KEY_FILE']=str(key)
    pgdata=root/'pgdata';pgport=free_port();proxyport=free_port()
    subprocess.run([a.pg_bin+'/initdb','-D',str(pgdata),'-A','trust','--no-locale','-E','UTF8','-U','dbx_fault_fixture'],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    pglog=open(root/'postgres.log','w+')
    pg=subprocess.Popen([a.pg_bin+'/postgres','-D',str(pgdata),'-h','127.0.0.1','-p',str(pgport),'-k','','-c','shared_buffers=16MB','-c','max_connections=20','-c','ssl=off'],env=env,stdout=pglog,stderr=pglog)
    mcp=None;hostlog=open(root/'mcp.log','w+')
    try:
        for _ in range(100):
            pglog.flush()
            if 'ready to accept connections' in pathlib.Path(pglog.name).read_text():break
            time.sleep(.05)
        else:raise AssertionError('fixture PostgreSQL not ready')
        installed=store/'plugins'/'io.xuedinge.pg-fault-lab';(installed/'bin').mkdir(parents=True)
        for n in ('manifest.json','ui','assets'):
            src=source/n;dst=installed/n
            if src.is_dir():shutil.copytree(src,dst)
            else:shutil.copy2(src,dst)
        shutil.copy2(a.sidecar,installed/'bin'/'dbx-pg-fault')
        cfg={'name':'external-fault-lab','db_type':'plugin','host':'127.0.0.1','port':pgport,'plugin_id':'io.xuedinge.pg-fault-lab','plugin_connection_provider':'io.xuedinge.pg-fault-lab.connection','plugin_connection_type':'pg-fault-lab','read_only':False,'external_config':{'proxy_port':proxyport,'disposable_lab':True,'allow_injection':True}}
        added=subprocess.run([a.dbx,'connections','add','--file','-','--json'],input=json.dumps({k:v for k,v in dict(cfg,db_type='postgres').items() if k in ('name','db_type','host','port','read_only')}),text=True,capture_output=True,env=env,timeout=20)
        assert added.returncode==0,added.stderr
        saved=json.loads(added.stdout);connection=saved['id']
        # CLI currently accepts only basic connection fields. Prepare the plugin
        # lifecycle metadata in this newly created disposable storage fixture;
        # this is not an operational recipe for editing an existing DBX store.
        with sqlite3.connect(store/'dbx.db') as fixture:
            current=json.loads(fixture.execute('SELECT config_json FROM connections WHERE id=?',(connection,)).fetchone()[0])
            current.update(cfg)
            fixture.execute('UPDATE connections SET config_json=? WHERE id=?',(json.dumps(current),connection))
        mcp=MCP(env,hostlog)
        tools=mcp.call('tools/list',{})['tools'];plugin=[x for x in tools if '__lab_' in x['name']]
        assert len(plugin)==7,[x['name'] for x in tools]
        names={x['name'].split('__',1)[1]:x['name'] for x in plugin}
        assert next(x for x in plugin if x['name']==names['lab_start'])['annotations']['readOnlyHint'] is False
        started=content(mcp.tool(names['lab_start'],{'dbx_connection':connection}));assert started['connected'] and started['address']==f'127.0.0.1:{proxyport}'
        def sql(query,port=proxyport,check=True):
            return subprocess.run([a.pg_bin+'/psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(port),'-U','dbx_fault_fixture','-d','postgres'],input=query,text=True,capture_output=True,env=dict(env,PGAPPNAME='external_mcp_app'),timeout=10,check=check)
        assert '42' in sql('SELECT 42;').stdout
        pause_rule={'selector':{'application':'external_mcp_app','command':'SELECT'},'phase':'execute','action':'pause','hits':1,'ttlMs':60000}
        content(mcp.tool(names['lab_add_rule'],{'rule':pause_rule}))
        waiting=subprocess.Popen([a.pg_bin+'/psql','-X','-A','-t','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',str(proxyport),'-U','dbx_fault_fixture','-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=dict(env,PGAPPNAME='external_mcp_app'))
        waiting.stdin.write('SELECT 43;\n\\q\n');waiting.stdin.flush()
        try:
            for _ in range(100):
                observed=content(mcp.tool(names['lab_snapshot']))
                if observed['pauses']:break
                time.sleep(.02)
            else:raise AssertionError('external MCP pause not observed')
            assert waiting.poll() is None,'SQL completed before resume'
            content(mcp.tool(names['lab_resume'],{'id':observed['pauses'][0]['id']}))
            out,err=waiting.communicate(timeout=10)
            assert waiting.returncode==0 and '43' in out,err
        finally:
            if waiting.poll() is None:waiting.kill();waiting.wait()
        rule={'selector':{'application':'external_mcp_app','command':'COMMIT'},'phase':'commit','action':'abort','hits':1,'ttlMs':60000}
        content(mcp.tool(names['lab_add_rule'],{'rule':rule}))
        sql('CREATE TABLE external_probe(id int PRIMARY KEY);',pgport)
        rejected=sql('BEGIN;\nINSERT INTO external_probe VALUES (1);\nCOMMIT;\n',check=False)
        assert rejected.returncode!=0,'COMMIT was not aborted'
        assert sql('SELECT count(*) FROM external_probe;',pgport).stdout.strip()=='0'
        observed=content(mcp.tool(names['lab_snapshot']))
        assert any(x['kind']=='injected_abort' for x in observed['events'])
        assert 'capability' not in json.dumps(observed)
        denied=mcp.tool(names['lab_snapshot'],{'dbx_connection':'nonexistent'});assert denied.get('isError'),'unknown connection allowed'
        content(mcp.tool(names['lab_stop']));mcp.close();mcp=None
        # Read-only host policy must prevent start, not merely hide an injector.
        readonly=dict(env,DBX_MCP_ALLOW_WRITES='0');mcp=MCP(readonly,hostlog)
        denied=mcp.tool(names['lab_start']);assert denied.get('isError'),'read-only host started listener'
        mcp.close();mcp=None
        with sqlite3.connect(store/'dbx.db') as fixture:
            current['read_only']=True
            fixture.execute('UPDATE connections SET config_json=? WHERE id=?',(json.dumps(current),connection))
        mcp=MCP(env,hostlog)
        denied=mcp.tool(names['lab_start']);assert denied.get('isError'),'saved read-only connection started listener'
        mcp.close();mcp=None
        with sqlite3.connect(store/'dbx.db') as fixture:
            current['read_only']=False;current['external_config']['allow_injection']=False
            fixture.execute('UPDATE connections SET config_json=? WHERE id=?',(json.dumps(current),connection))
        mcp=MCP(env,hostlog)
        observed_start=content(mcp.tool(names['lab_start']));assert observed_start['allowInjection'] is False
        denied=mcp.tool(names['lab_add_rule'],{'rule':rule});assert denied.get('isError'),'saved injection opt-out ignored'
        content(mcp.tool(names['lab_stop']))
        print('PASS: real dbx-mcp manifest registry, 7-tool discovery, host-bound lifecycle, real PostgreSQL query/pause/resume, COMMIT abort/zero rows, observer redaction, unknown-connection rejection host/saved read-only denial and saved injection opt-out')
        for name in ('dbx','mcp','sidecar'):print(name+' SHA256 '+hashlib.sha256(pathlib.Path(getattr(a,name)).read_bytes()).hexdigest())
    except Exception:
        hostlog.flush();print('MCP diagnostic:',pathlib.Path(hostlog.name).read_text()[-6000:]);raise
    finally:
        if mcp:mcp.close()
        pg.terminate()
        try:pg.wait(timeout=5)
        except subprocess.TimeoutExpired:pg.kill();pg.wait()
        hostlog.close();pglog.close()
