import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const compiler = process.env.NSIS_MAKENSIS || path.join(process.env.LOCALAPPDATA || '', 'tauri', 'NSIS', 'makensis.exe')
const available = process.platform === 'win32' && existsSync(compiler)

test('Windows installer access checks and elevation handoff', { skip: !available }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbx installer test '))
  const template = readFileSync(new URL('../src-tauri/windows/nsis/installer.nsi', import.meta.url), 'utf8')
  const helper = template.match(/Function DbxEnsureInstallAccess\r?\n[\s\S]*?FunctionEnd/)[0]
  const elevationInit = template.slice(template.indexOf('Function .onInit\n') + 'Function .onInit\n'.length, template.indexOf('  \u0024{GetOptions} $CMDLINE "/P" $PassiveMode'))
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
!include MUI2.nsh
!include FileFunc.nsh
!define MAINBINARYNAME "dbx"
Name "DBX access probe"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
Var DbxElevated
Var DbxTestCancel
Var DbxTestHandle
!insertmacro MUI_LANGUAGE "English"
LangString dbxElevationFailed \u0024{LANG_ENGLISH} "Elevation cancelled"
LangString dbxElevationUserMismatch \u0024{LANG_ENGLISH} "Different user"
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
    assert.equal(readFileSync(binary, 'utf8'), 'original executable contents')

    const locked = run(['/TEST_LOCK'])
    assert.equal(locked.status, 0)
    assert.doesNotMatch(locked.output, /handoff/)
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
