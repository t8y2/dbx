# Source this file to complete DBX database Make targets and DB=<product>@<version> values.

_dbx_make_repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [[ -z ${_dbx_make_previous_completion+x} ]]; then
  _dbx_make_previous_completion=''
  _dbx_make_completion_spec="$(complete -p make 2>/dev/null || true)"
  if [[ "$_dbx_make_completion_spec" =~ -F[[:space:]]+([^[:space:]]+) ]]; then
    _dbx_make_previous_completion="${BASH_REMATCH[1]}"
  fi
  unset _dbx_make_completion_spec
fi

_dbx_make_database_selectors() {
  node "$_dbx_make_repository_root/scripts/database-env.mjs" selectors 2>/dev/null
}

_dbx_make_targets() {
  node "$_dbx_make_repository_root/scripts/database-env.mjs" make-targets 2>/dev/null
}

_dbx_make_fallback() {
  local current="${COMP_WORDS[COMP_CWORD]}"
  if [[ -n "$_dbx_make_previous_completion" ]] && declare -F "$_dbx_make_previous_completion" >/dev/null; then
    "$_dbx_make_previous_completion"
    return
  fi

  COMPREPLY=()
  [[ "$1" == targets ]] || return

  local targets
  targets="$(_dbx_make_targets)"
  COMPREPLY=( $(compgen -W "$targets" -- "$current") )
}

_dbx_make() {
  local current="${COMP_WORDS[COMP_CWORD]}"
  local target="${COMP_WORDS[1]}"
  local selectors

  if [[ "$(pwd -P)" != "$_dbx_make_repository_root" ]]; then
    _dbx_make_fallback
    return
  fi
  if (( COMP_CWORD == 1 )); then
    _dbx_make_fallback targets
    return
  fi

  case "$target" in
    db|db-verify|db-down|db-reset)
      compopt +o bashdefault +o default 2>/dev/null || true
      case "$current" in
        DB=*)
          selectors="$(_dbx_make_database_selectors)"
          COMPREPLY=( $(compgen -W "$(printf 'DB=%s ' $selectors)" -- "$current") )
          ;;
        CONFIRM=*)
          COMPREPLY=( $(compgen -W 'CONFIRM=1' -- "$current") )
          ;;
        *)
          if [[ "$target" == 'db-reset' ]]; then
            COMPREPLY=( $(compgen -W 'DB= DB_BIND_ADDRESS= DB_PORT= DB_PASSWORD= CONFIRM=1' -- "$current") )
          else
            COMPREPLY=( $(compgen -W 'DB= DB_BIND_ADDRESS= DB_PORT= DB_PASSWORD=' -- "$current") )
          fi
          ;;
      esac
      ;;
    *)
      _dbx_make_fallback
      ;;
  esac
}

complete -o bashdefault -o default -F _dbx_make make
