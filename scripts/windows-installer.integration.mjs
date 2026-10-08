// Opt-in Windows integration test. Requires NSIS, gh, and handlebars installed
// in an isolated fixture directory (npm install --prefix <directory> handlebars).
// Run: node scripts/windows-installer.integration.mjs <directory>
// Uses real runas elevation; approve UAC if Windows prompts. The full production
// installer template installs a disposable test app, never the user's DBX.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
assert.equal(process.platform, 'win32', 'This integration test requires Windows');
assert.ok(process.argv[2], 'Pass an isolated fixture directory containing handlebars');
const root = path.resolve(process.argv[2]);
const hb = createRequire(path.join(root, 'package.json'))('handlebars');
const repo = fileURLToPath(new URL('..', import.meta.url));
const compiler = path.join(process.env.LOCALAPPDATA, 'tauri/NSIS/makensis.exe');
const product = `DBX Issue10895 Test ${Date.now()}`;
const manufacturer = 'DBXInstallerIntegrationTest';
const target = path.join(root, 'protected DBX folder');
const report = path.join(root, 'report.ini');
const mainName = 'dbx-10895-test-app';
const registry = `Software\\${manufacturer}\\${product}`;
const uninstallRegistry = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`;
const ref = '9b17a7aeae9a83222ffe829aa4e2d8a5ba6bed8c';
// Refuse to overwrite existing fixture installs. Cleanup only these exact paths
// and the unique test registry keys, leaving source files and reports for review.
assert.equal(fs.existsSync(target), false, 'Fixture destination already exists');
assert.equal(fs.existsSync(path.join(root, 'writable DBX folder')), false, 'Writable fixture destination already exists');
fs.rmSync(report, {force:true});
function compile(name, source) {
  const file = path.join(root, `${name}.nsi`);
  fs.writeFileSync(file, source);
  const out = execFileSync(compiler, ['/V1', '/INPUTCHARSET', 'UTF8', file], {cwd:root, encoding:'utf8', timeout:30000});
  if(out.trim()) console.log(out.trim());
}
function run(name, args = []) {
  const exe = path.join(root, `${name}.exe`);
  execFileSync(exe,args,{cwd:root,argv0:`"${exe}"`,windowsVerbatimArguments:true,timeout:30000});
}
function base(name, level='user') {
  return `Unicode true\n!include MUI2.nsh\n!include FileFunc.nsh\nName "${name}"\nOutFile "${root}\\${name}.exe"\nRequestExecutionLevel ${level}\nSilentInstall silent\n`;
}
async function waitFor(check) {
  const end = Date.now()+30000;
  while(Date.now()<end) {
    if(check()) return;
    await new Promise(r=>setTimeout(r,200));
  }
  throw new Error('Timed out waiting for elevated installer: '+(fs.existsSync(report)?fs.readFileSync(report,'utf8'):''));
}
async function main() {
  for(const file of ['utils.nsh','FileAssociation.nsh','languages/English.nsh','languages/SimpChinese.nsh','languages/TradChinese.nsh']) {
    const data=JSON.parse(execFileSync('gh',['api',`repos/tauri-apps/tauri/contents/crates/tauri-bundler/src/bundle/windows/nsis/${file}?ref=${ref}`],{encoding:'utf8'}));
    fs.writeFileSync(path.join(root,path.basename(file)),Buffer.from(data.content,'base64'));
  }
  for(const version of ['old','new']) {
    compile(`${mainName}-${version}`,base(`${mainName}-${version}`)+`
Function .onInit
  WriteINIStr "${report}" "app" "version" "${version}"
  WriteINIStr "${report}" "app" "cmdline" "$CMDLINE"
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  WriteINIStr "${report}" "app" "admin" "$0"
  \u0024{GetOptions} $CMDLINE "/HOLD" $0
  \u0024{IfNot} \u0024{Errors}
    WriteINIStr "${report}" "app" "holding" "1"
    Sleep 120000
  \u0024{EndIf}
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`);
  }
  fs.copyFileSync(path.join(root,`${mainName}-new.exe`),path.join(root,`${mainName}.exe`));
  fs.writeFileSync(path.join(root,'payload.txt'),'updated resource payload');
  fs.writeFileSync(path.join(root,'hooks.nsh'),`
!macro NSIS_HOOK_PREINSTALL
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  WriteINIStr "${report}" "installer" "admin" "$0"
  WriteINIStr "${report}" "installer" "cmdline" "$CMDLINE"
  WriteINIStr "${report}" "installer" "language" "$LANGUAGE"
  WriteINIStr "${report}" "installer" "update" "$UpdateMode"
  WriteINIStr "${report}" "installer" "passive" "$PassiveMode"
  WriteINIStr "${report}" "installer" "noShortcut" "$NoShortcutMode"
!macroend
!macro NSIS_HOOK_POSTINSTALL
  WriteINIStr "${report}" "installer" "complete" "1"
!macroend
`);
  const data={compression:'lzma',installer_hooks:path.join(root,'hooks.nsh'),manufacturer,product_name:product,version:'1.0.1',version_with_build:'1.0.1.0',install_mode:'currentUser',main_binary_name:mainName,main_binary_path:path.join(root,`${mainName}.exe`),bundle_id:'com.dbx.integration10895',copyright:'DBX installer test',out_file:path.join(root,'installer.exe'),arch:'x64',additional_plugins_path:path.join(process.env.LOCALAPPDATA,'tauri/NSIS/Plugins/x86-unicode/additional'),allow_downgrades:'true',display_language_selector:'false',install_webview2_mode:'',estimated_size:1024,start_menu_folder:'',languages:['English','SimpChinese','TradChinese'],language_files:['English.nsh','SimpChinese.nsh','TradChinese.nsh'],resources:{[path.join(root,'payload.txt')]:[path.join(root,'payload.txt'),'payload.txt']}};
  hb.registerHelper('no-escape',value=>new hb.SafeString(value));
  const template = fs.readFileSync(path.join(repo,'src-tauri/windows/nsis/installer.nsi'),'utf8');
  compile('installer',hb.compile(template,{noEscape:true})(data));
  compile('seed',base('seed','admin')+`
Section
  CreateDirectory "${target}"
  SetOutPath "${target}"
  File /oname=${mainName}.exe "${root}\\${mainName}-old.exe"
  FileOpen $0 "${target}\\payload.txt" w
  FileWrite $0 "old resource payload"
  FileClose $0
  WriteRegStr HKCU "${registry}" "" "${target}"
  WriteRegStr HKCU "${uninstallRegistry}" "" "${target}"
  WriteRegStr HKCU "${uninstallRegistry}" "DisplayVersion" "1.0.0"
  WriteRegStr HKCU "${uninstallRegistry}" "UninstallString" '"${target}\\uninstall.exe"'
  ExecWait '"$SYSDIR\\icacls.exe" "${target}" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-545:(OI)(CI)RX"' $0
  WriteINIStr "${report}" "seed" "aclExit" "$0"
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  WriteINIStr "${report}" "seed" "admin" "$0"
SectionEnd
`);
  compile('driver',base('driver')+`
Function .onInit
  System::Call 'shell32::IsUserAnAdmin() i .r0'
  WriteINIStr "${report}" "driver" "admin" "$0"
  ExecShellWait "runas" "${root}\\seed.exe"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`);
  compile('cleanup',base('cleanup','admin')+`
Section
  RMDir /r "${target}"
  RMDir /r "${root}\\writable DBX folder"
  DeleteRegKey HKCU "${registry}"
  DeleteRegKey /ifempty HKCU "Software\\${manufacturer}"
  DeleteRegKey HKCU "${uninstallRegistry}"
SectionEnd
`);
  compile('cleanup-driver',base('cleanup-driver')+`
Function .onInit
  ExecShellWait "runas" "${root}\\cleanup.exe"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`);
  run('driver');
  console.log(fs.readFileSync(report,'utf8'));
  assert.throws(()=>fs.openSync(path.join(target,`${mainName}.exe`),'r+'),/EACCES|EPERM/);
  const oldApp=spawn(path.join(target,`${mainName}.exe`),['/HOLD'],{windowsHide:true,stdio:'ignore'});
  await waitFor(()=>fs.readFileSync(report,'utf8').includes('holding=1'));
  assert.equal(oldApp.exitCode,null);
  run('installer',['/UPDATE','/P','/NS','/R','/ARGS','"argument with spaces"']);
  await waitFor(()=>fs.existsSync(report)&&fs.readFileSync(report,'utf8').includes('version=new'));
  const output=fs.readFileSync(report,'utf8');
  console.log(output);
  assert.match(output,/\[driver\]\r?\nadmin=0/);
  assert.match(output,/\[installer\]\r?\nadmin=1/);
  assert.match(output,/complete=1/);
  assert.match(output,/update=1/);
  assert.match(output,/passive=1/);
  assert.match(output,/noShortcut=1/);
  assert.match(output,/\/DBX_ELEVATED/);
  assert.match(output,/\[app\][\s\S]*version=new[\s\S]*argument with spaces/);
  assert.deepEqual(fs.readFileSync(path.join(target,`${mainName}.exe`)),fs.readFileSync(path.join(root,`${mainName}.exe`)));
  assert.equal(fs.readFileSync(path.join(target,'payload.txt'),'utf8'),'updated resource payload');
  assert.ok(fs.existsSync(path.join(target,'uninstall.exe')));
  assert.notEqual(oldApp.exitCode,null,'old application was stopped before overwrite');
  console.log('REAL ELEVATION AND FULL TEMPLATE UPDATE WITH RUNNING OLD APP: PASS');
  fs.copyFileSync(report,path.join(root,'protected-update-report.ini'));
  fs.unlinkSync(report);
  const writableTarget=path.join(root,'writable DBX folder');
  run('installer',['/S','/UPDATE','/NS','/R','/ARGS','"writable update argument"',`/D=${writableTarget}`]);
  await waitFor(()=>fs.existsSync(report)&&fs.readFileSync(report,'utf8').includes('version=new'));
  const writableOutput=fs.readFileSync(report,'utf8');
  console.log(writableOutput);
  assert.match(writableOutput,/\[installer\]\r?\nadmin=0/);
  assert.doesNotMatch(writableOutput,/\/DBX_ELEVATED/);
  assert.equal(fs.readFileSync(path.join(writableTarget,'payload.txt'),'utf8'),'updated resource payload');
  console.log('FULL TEMPLATE INSTALL TO WRITABLE FOLDER WITHOUT ELEVATION: PASS');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{
  if(fs.existsSync(path.join(root,'cleanup-driver.exe'))) {
    run('cleanup-driver');
    assert.equal(fs.existsSync(target),false,'Protected fixture was not removed');
    assert.equal(fs.existsSync(path.join(root,'writable DBX folder')),false,'Writable fixture was not removed');
  }
});
