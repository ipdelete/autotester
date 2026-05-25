import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PromptScope } from "./prompt.js";

export const CONFIG_FILENAME = ".autotester.json";
export const HOOK_MARKER = "# >>> autotester managed pre-commit hook <<<";
export const HOOK_END_MARKER = "# <<< autotester managed pre-commit hook >>>";

export interface AutotesterConfig {
  readonly: string[];
  editable: string[];
}

export function configPath(repo: string): string {
  return resolve(repo, CONFIG_FILENAME);
}

export function loadConfig(repo: string): AutotesterConfig | undefined {
  const path = configPath(repo);
  if (!existsSync(path)) {
    return undefined;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AutotesterConfig>;
  return {
    readonly: Array.isArray(parsed.readonly) ? parsed.readonly.map(String) : [],
    editable: Array.isArray(parsed.editable) ? parsed.editable.map(String) : [],
  };
}

export function writeConfig(repo: string, config: AutotesterConfig): void {
  writeFileSync(configPath(repo), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function configToScope(config: AutotesterConfig | undefined): PromptScope | undefined {
  if (!config) {
    return undefined;
  }
  if (config.readonly.length === 0 && config.editable.length === 0) {
    return undefined;
  }
  return { readonly: config.readonly, editable: config.editable };
}

/**
 * The hook is a small POSIX shell script that reads `.autotester.json` and
 * rejects a commit whose staged paths fall outside `editable` or hit
 * `readonly`. It uses shell case-glob matching, which honors `*`, `?`, and
 * `[…]`. For `**` we fall back to a leading-prefix interpretation: a glob
 * `src/**` matches anything starting with `src/`.
 *
 * The hook is intentionally dependency-free (no node, no python) so it
 * works in any repo. It reads JSON with a small `sed`+`tr` pipeline that
 * extracts the arrays. If anything goes wrong reading the config, the hook
 * exits 0 (fail-open) so a broken config can't permanently block commits.
 */
export function hookScript(): string {
  return `#!/bin/sh
${HOOK_MARKER}
# Installed by 'autotester init'. Do not edit between these markers.
# Reject commits whose staged paths violate the scope declared in
# .autotester.json. Bypass with 'git commit --no-verify'.

set -eu

repo_root=$(git rev-parse --show-toplevel)
config="$repo_root/.autotester.json"

if [ ! -f "$config" ]; then
  exit 0
fi

# Extract a JSON string array by key. Tolerates whitespace/newlines.
# Usage: extract_array <key>
extract_array() {
  key="$1"
  tr -d '\\n' < "$config" \\
    | sed -n "s/.*\\\"$key\\\"[[:space:]]*:[[:space:]]*\\\\[\\\\([^]]*\\\\)\\\\].*/\\\\1/p" \\
    | tr ',' '\\n' \\
    | sed -e 's/^[[:space:]]*\\\"//' -e 's/\\\"[[:space:]]*$//' \\
    | sed '/^$/d'
}

readonly_globs=$(extract_array readonly || true)
editable_globs=$(extract_array editable || true)

# match_glob <path> <glob> -> exit 0 if path matches glob
match_glob() {
  path="$1"
  glob="$2"
  case "$glob" in
    *'**'*)
      # Treat '**' as 'any characters including /'. Convert to a shell prefix
      # match by replacing '**' with '*' and using case glob, which then
      # only does single-segment matching; so we also do a literal prefix
      # check for the part before the first '**'.
      prefix=\${glob%%'**'*}
      case "$path" in
        "$prefix"*) return 0 ;;
      esac
      return 1
      ;;
    *)
      case "$path" in
        $glob) return 0 ;;
      esac
      return 1
      ;;
  esac
}

blocked=0
staged=$(git diff --cached --name-only --diff-filter=ACMRT)

for path in $staged; do
  # readonly check
  for glob in $readonly_globs; do
    [ -z "$glob" ] && continue
    if match_glob "$path" "$glob"; then
      echo "blocked: $path matches readonly glob '$glob'" >&2
      blocked=1
      break
    fi
  done

  # editable check (only enforced when editable list is non-empty)
  if [ -n "$editable_globs" ]; then
    allowed=0
    for glob in $editable_globs; do
      [ -z "$glob" ] && continue
      if match_glob "$path" "$glob"; then
        allowed=1
        break
      fi
    done
    if [ "$allowed" -eq 0 ]; then
      echo "blocked: $path is outside editable globs" >&2
      blocked=1
    fi
  fi
done

if [ "$blocked" -ne 0 ]; then
  echo "autotester pre-commit hook rejected the commit. Bypass with --no-verify." >&2
  exit 1
fi

exit 0
${HOOK_END_MARKER}
`;
}

/**
 * Install the autotester pre-commit hook. If a non-managed hook already
 * exists, move it aside to `<hook>.user` and chain it from the new hook so
 * the user's hook runs first.
 */
export function installPreCommitHook(repo: string): { installed: boolean; chained: boolean } {
  const hooksDir = resolve(repo, ".git", "hooks");
  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }
  const hookPath = resolve(hooksDir, "pre-commit");
  const userHookPath = resolve(hooksDir, "pre-commit.user");

  let chained = false;
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf8");
    if (existing.includes(HOOK_MARKER)) {
      // Already a managed hook; rewrite it idempotently.
      writeFileSync(hookPath, hookScript(), "utf8");
      chmodSync(hookPath, 0o755);
      return { installed: true, chained: false };
    }
    // Preserve the existing hook and chain it.
    if (!existsSync(userHookPath)) {
      renameSync(hookPath, userHookPath);
      chmodSync(userHookPath, 0o755);
    }
    chained = true;
  }

  let script = hookScript();
  if (chained) {
    const chainSnippet = `if [ -x "$(git rev-parse --git-path hooks/pre-commit.user)" ]; then\n  "$(git rev-parse --git-path hooks/pre-commit.user)" "$@" || exit $?\nfi\n`;
    script = script.replace(
      "set -eu\n",
      `set -eu\n\n${chainSnippet}\n`,
    );
  }

  // Ensure parent dir exists when repo is freshly cloned in odd setups.
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, script, "utf8");
  chmodSync(hookPath, 0o755);
  return { installed: true, chained };
}
