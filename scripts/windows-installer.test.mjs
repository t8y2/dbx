import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const compiler = process.env.NSIS_MAKENSIS || (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe')
  : 'makensis')
let compilerAvailable = false
try {
  execFileSync(compiler, [process.platform === 'win32' ? '/VERSION' : '-VERSION'], { timeout: 5000 })
  compilerAvailable = true
} catch {}
const available = process.platform === 'win32' && compilerAvailable
const template = readFileSync(new URL('../src-tauri/windows/nsis/installer.nsi', import.meta.url), 'utf8')
const diagnosticVariables = template.match(/^Var Dbx.*$/gm).join('\n')
const diagnostics = template.slice(template.indexOf('AllowSkipFiles off'), template.indexOf('; Probe without truncating'))
const elevationInit = template.slice(template.indexOf('Function .onInit\n') + 'Function .onInit\n'.length, template.indexOf('  \u0024{GetOptions} $CMDLINE "/P" $PassiveMode'))
const languages = ['English', 'SimpChinese', 'TradChinese'].map(language => `!insertmacro MUI_LANGUAGE "${language}"`).join('\n')

test('Windows installer access checks and elevation handoff', { skip: !available }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx installer test '))
  const helper = template.match(/Function DbxEnsureInstallAccess\r?\n[\s\S]*?FunctionEnd/)[0]
  assert.ok(elevationInit.includes('/DBX_PROFILE='))
  const launch = `ExecShell "runas" "$EXEPATH" '/DBX_ELEVATED /DBX_PROFILE="$3" /DBX_LANG=$LANGUAGE $2 /D=$INSTDIR'`
  assert.ok(helper.includes(launch))
  // Execute the production function, replacing only the OS UAC launch with a
  // recorder. Tests must never trigger an interactive prompt or install DBX.
  const fixtureHelper = helper.replace(launch, `WriteINIStr "\u0024EXEDIR\\result.ini" "handoff" "args" '/DBX_ELEVATED /DBX_PROFILE="$3" /DBX_LANG=$LANGUAGE $2 /D=$INSTDIR'
    \u0024{If} \u0024DbxTestCancel = 1
      SetErrors
    \u0024{EndIf}`)
  const exe = path.join(dir, 'probe.exe')
  const result = path.join(dir, 'result.ini')
  const destination = path.join(dir, 'existing DBX')
  mkdirSync(destination)
  const binary = path.join(destination, 'dbx.exe')
  writeFileSync(binary, 'original executable contents')
  const script = `Unicode true
XPStyle on
!include MUI2.nsh
!include FileFunc.nsh
!define MAINBINARYNAME "dbx"
!define VERSION "1.0.1"
Name "DBX access probe"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
${diagnosticVariables}
Var DbxTestCancel
Var DbxTestHandle
${languages}
${diagnostics}
${fixtureHelper}
Function .onInit
${elevationInit}
  \u0024{If} $DbxElevated <> 1
    StrCpy $LANGUAGE 1033
  \u0024{EndIf}
  \u0024{GetOptions} $CMDLINE "/TEST_ELEVATED" $0
  \u0024{IfNot} \u0024{Errors}
    StrCpy $DbxElevated 1
  \u0024{EndIf}
  \u0024{GetOptions} $CMDLINE "/TEST_LOCK" $0
  \u0024{IfNot} \u0024{Errors}
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\\dbx.exe", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .r0'
    StrCpy $DbxTestHandle $0
  \u0024{EndIf}
  \u0024{GetOptions} $CMDLINE "/TEST_CANCEL" $0
  \u0024{IfNot} \u0024{Errors}
    StrCpy $DbxTestCancel 1
  \u0024{EndIf}
  StrCpy $0 "register zero"
  StrCpy $1 "register one"
  StrCpy $2 "register two"
  StrCpy $3 "register three"
  Call DbxEnsureInstallAccess
  WriteINIStr "$EXEDIR\\result.ini" "probe" "registers" "$0|$1|$2|$3"
  WriteINIStr "$EXEDIR\\result.ini" "probe" "destination" "$INSTDIR"
  WriteINIStr "$EXEDIR\\result.ini" "probe" "language" "$LANGUAGE"
  WriteINIStr "$EXEDIR\\result.ini" "probe" "elevation" "$DbxElevationStatus"
  WriteINIStr "$EXEDIR\\result.ini" "probe" "fileError" "$DbxFileProbeError"
  WriteINIStr "$EXEDIR\\result.ini" "probe" "folderError" "$DbxDirectoryProbeError"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`
  const source = path.join(dir, 'probe.nsi')
  writeFileSync(source, script)
  try {
    // Also compile the unmodified production launch instruction and init code.
    writeFileSync(source, script.replace(fixtureHelper, helper))
    execFileSync(compiler, ['/V2', source], { encoding: 'utf8', timeout: 30_000 })
    writeFileSync(source, script)
    execFileSync(compiler, ['/V2', source], { encoding: 'utf8', timeout: 30_000 })
    const run = (args, target = destination) => {
      rmSync(result, { force: true })
      let status = 0
      try {
        execFileSync(exe, [...args, ...(target === null ? [] : [`/D=${target}`])], { timeout: 15_000, windowsVerbatimArguments: true, argv0: `"${exe}"` })
      } catch (error) {
        if (typeof error.status !== 'number') throw error
        status = error.status
      }
      return { status, output: existsSync(result) ? readFileSync(result, 'utf8') : '' }
    }
    const writable = run([])
    assert.equal(writable.status, 0, writable.output)
    assert.match(writable.output, /register zero\|register one\|register two\|register three/)
    assert.doesNotMatch(writable.output, /handoff/)
    assert.match(writable.output, /elevation=Not requested/)
    assert.match(writable.output, /fileError=0/)
    assert.match(writable.output, /folderError=0/)
    assert.equal(readFileSync(binary, 'utf8'), 'original executable contents')

    const locked = run(['/TEST_LOCK'])
    assert.equal(locked.status, 0)
    assert.doesNotMatch(locked.output, /handoff/)
    assert.match(locked.output, /fileError=32/)
    assert.match(locked.output, /folderError=0/)
    assert.equal(readFileSync(binary, 'utf8'), 'original executable contents')

    const nested = run([], path.join(destination, 'new', 'nested DBX'))
    assert.equal(nested.status, 0)
    assert.doesNotMatch(nested.output, /handoff/)
    assert.equal(existsSync(path.join(destination, 'new')), false)

    // The read-only attribute yields ERROR_ACCESS_DENIED without changing ACLs.
    execFileSync('attrib.exe', ['+R', binary])
    const update = run(['/UPDATE', '/P', '/NS', '/R', '/ARGS', '"argument with spaces"'])
    assert.equal(update.status, 0)
    assert.match(update.output, /\/DBX_ELEVATED \/DBX_PROFILE="[^"]+" \/DBX_LANG=1033 \/UPDATE \/P \/NS \/R \/ARGS "argument with spaces" \/D=/)
    assert.ok(update.output.includes(`/D=${destination}`))
    assert.doesNotMatch(update.output, /registers=/)
    assert.equal(readFileSync(binary, 'utf8'), 'original executable contents')

    const resumed = run([update.output.match(/args=(.*)/)[1]], null)
    assert.equal(resumed.status, 0)
    assert.doesNotMatch(resumed.output, /handoff/)
    assert.ok(resumed.output.includes(`destination=${destination}`))
    assert.match(resumed.output, /language=1033/)

    const cancelled = run(['/TEST_CANCEL'])
    assert.equal(cancelled.status, 740)
    assert.doesNotMatch(cancelled.output, /registers=/)

    const elevated = run(['/TEST_ELEVATED'])
    assert.equal(elevated.status, 0)
    assert.doesNotMatch(elevated.output, /handoff/)
    assert.match(elevated.output, /elevation=Attempted; administrator permission not obtained/)
    assert.match(elevated.output, /register zero\|register one\|register two\|register three/)

    const wrongUser = run(['/DBX_ELEVATED', '/DBX_LANG=1033', '/DBX_PROFILE="different Windows account"'])
    assert.equal(wrongUser.status, 740)
    assert.equal(wrongUser.output, '')

    // A machine-protected directory also requests elevation, including a
    // destination that does not exist yet. No files are installed there.
    const protectedPath = path.join(process.env.ProgramFiles, 'DBX access probe', 'nested')
    const protectedFolder = run(['/UPDATE'], protectedPath)
    assert.match(protectedFolder.output, /handoff/)
    assert.equal(existsSync(protectedPath), false)
  } finally {
    if (existsSync(binary)) execFileSync('attrib.exe', ['-R', binary])
    rmSync(dir, { recursive: true, force: true })
  }
})

// Compile the actual diagnostic strings and write policy on any host with NSIS.
// On Windows also execute a locked-file extraction: it must stop before the
// completion marker, and its expanded dialog must contain usable diagnostics.
test('Installer write failure diagnostics compile', { skip: !compilerAvailable }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx write failure '))
  const payload = path.join(dir, 'payload.txt')
  const source = path.join(dir, 'failure.nsi')
  const exe = path.join(dir, 'failure.exe')
  const target = path.join(dir, 'destination')
  const report = path.join(dir, 'result.ini')
  mkdirSync(target)
  writeFileSync(payload, 'new executable contents')
  // Simulate only the user's Manual installation selection and Explorer launch.
  // Keep the production extraction policy, dialog code and exit handler intact.
  const fixtureDiagnostics = diagnostics
    .replace('Function DbxShowWriteError', 'Function DbxShowWriteErrorActual')
    .replace('    Call DbxShowWriteError\n', '    Call DbxShowWriteError\n    WriteINIStr "$EXEDIR\\result.ini" "trace" "action" "$DbxWriteFailureAction"\n')
    .replace('  StrCpy $DbxWriteFailureAction ${IDCANCEL}\n', '  StrCpy $DbxWriteFailureAction ${IDCANCEL}\n  WriteINIStr "$EXEDIR\\result.ini" "trace" "dialog" "entered"\n')
    .replace('    Goto dbx_write_dialog_done\n', '    WriteINIStr "$EXEDIR\\result.ini" "trace" "silent" "1"\n    Goto dbx_write_dialog_done\n')
    .replace('  dbx_write_dialog_done:\n', '  dbx_write_dialog_done:\n    WriteINIStr "$EXEDIR\\result.ini" "trace" "dialog" "returning"\n')
    .replace(`ExecShell "open" "$WINDIR\\explorer.exe" '/select,"$EXEPATH"'`,
      `WriteINIStr "$EXEDIR\\result.ini" "manual" "args" '/select,"$EXEPATH"'`)
  const dialogSelection = `Function DbxShowWriteError
  \u0024{If} $TestManual = 1
    StrCpy $DbxWriteFailureAction 1001
  \u0024{ElseIf} $TestRetry = 1
    StrCpy $TestRetry 0
    System::Call 'kernel32::CloseHandle(p $TestHandle)'
    StrCpy $DbxWriteFailureAction \u0024{IDRETRY}
  \u0024{Else}
    Call DbxShowWriteErrorActual
  \u0024{EndIf}
FunctionEnd`
  const script = `Unicode true
XPStyle on
!include MUI2.nsh
!include FileFunc.nsh
!define VERSION "1.0.1"
!define MAINBINARYNAME "dbx"
Name "DBX required file write test"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
${diagnosticVariables}
Var TestHandle
Var TestManual
Var TestRetry
${languages}
${fixtureDiagnostics}
${dialogSelection}
${template.match(/Function DbxEnsureInstallAccess\r?\n[\s\S]*?FunctionEnd/)[0]}
Function .onInit
${elevationInit}
  \u0024{GetOptions} $CMDLINE "/LANG=" $0
  StrCpy $LANGUAGE $0
  \u0024{GetOptions} $CMDLINE "/LOCK" $0
  \u0024{IfNot} \u0024{Errors}
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\\dbx.exe", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p .s'
    Pop $TestHandle
  \u0024{EndIf}
  \u0024{GetOptions} $CMDLINE "/MANUAL" $0
  \u0024{IfNot} \u0024{Errors}
    StrCpy $TestManual 1
  \u0024{EndIf}
  \u0024{GetOptions} $CMDLINE "/RETRY" $0
  \u0024{IfNot} \u0024{Errors}
    StrCpy $TestRetry 1
  \u0024{EndIf}
  Call DbxEnsureInstallAccess
  \u0024{GetOptions} $CMDLINE "/READONLY" $0
  \u0024{IfNot} \u0024{Errors}
    SetFileAttributes "$INSTDIR\\dbx.exe" READONLY
  \u0024{EndIf}
FunctionEnd
Section
  SetOutPath $INSTDIR
  ; NSIS applies the selected language after .onInit returns.
  Call DbxUpdateElevationStatus
  StrCpy $0 "$INSTDIR\\dbx.exe"
  WriteINIStr "$EXEDIR\\result.ini" "diagnostics" "dialog" "$(dbxFileWriteErrorNoIgnore)"
  !insertmacro DbxExtractFile "/oname=dbx.exe" "${payload}" "$INSTDIR\\dbx.exe"
  WriteINIStr "$EXEDIR\\result.ini" "install" "complete" "1"
SectionEnd
`
  try {
    writeFileSync(source, script)
    const flag = process.platform === 'win32' ? '/' : '-'
    execFileSync(compiler, [`${flag}V2`, `${flag}INPUTCHARSET`, 'UTF8', source], { encoding: 'utf8', timeout: 30_000 })
    await t.test('Windows locked-file extraction stops and reports diagnostics', { skip: !available }, () => {
      for (const [language, elevation] of [
        ['1033', /Not requested|Already running as administrator/],
        ['2052', /未请求|启动时已有管理员权限/],
        ['1028', /未請求|啟動時已有系統管理員權限/],
      ]) {
        for (const action of ['writable', 'readonly', 'retry', 'cancel', 'manual']) {
          t.diagnostic(`Windows extraction: language=${language}, action=${action}`)
          const locked = ['retry', 'cancel', 'manual'].includes(action)
          writeFileSync(path.join(target, 'dbx.exe'), 'original executable contents')
          // Win32 INI writes otherwise use the runner's ANSI code page.
          writeFileSync(report, '\ufeff', 'utf16le')
          let exitCode = 0
          try {
            execFileSync(exe, ['/S', `/LANG=${language}`, ...(locked ? ['/LOCK'] : []), ...(action === 'manual' ? ['/MANUAL'] : []), ...(action === 'retry' ? ['/RETRY'] : []), ...(action === 'readonly' ? ['/READONLY'] : []), `/D=${target}`], { timeout: 15_000, windowsVerbatimArguments: true, argv0: `"${exe}"` })
          } catch (error) {
            if (typeof error.status !== 'number') {
              const diagnostic = existsSync(report) ? readFileSync(report, 'utf16le') : 'No fixture report'
              throw new Error(`language=${language}, action=${action}: ${error.message}\n${diagnostic}`, { cause: error })
            }
            exitCode = error.status
          }
          const output = readFileSync(report, 'utf16le')
          assert.ok(output.includes(exe), output)
          assert.ok(output.includes(target), output)
          assert.match(output, elevation)
          assert.ok(output.includes('1.0.1'), output)
          assert.doesNotMatch(output, /Program Files|\$Dbx|\$EXEPATH|\$INSTDIR/)
          if (action === 'cancel' || action === 'manual') {
            assert.notEqual(exitCode, 0, 'A failed required-file write must fail installation')
            assert.doesNotMatch(output, /complete=1/)
            if (action === 'manual') assert.ok(output.includes(`args=/select,"${exe}"`), output)
            else assert.doesNotMatch(output, /\[manual\]/)
            assert.equal(readFileSync(path.join(target, 'dbx.exe'), 'utf8'), 'original executable contents')
          } else {
            assert.equal(exitCode, 0)
            assert.match(output, /complete=1/)
            assert.equal(readFileSync(path.join(target, 'dbx.exe'), 'utf8'), 'new executable contents')
          }
        }
      }
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
