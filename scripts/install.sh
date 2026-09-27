#!/usr/bin/env bash
# Install or update this fork of opencode-claude-memory and point opencode at it.
#
#   scripts/install.sh [--dir DIR] [--config FILE] [--no-config]
#
# Run it from a checkout to build that checkout, or on its own to clone into
# ~/.local/share/opencode-claude-memory (or --dir). Rerunning pulls and rebuilds.
# The opencode config (global opencode.json or opencode.jsonc unless --config
# is given) gets a file:// plugin entry for the checkout in place of any
# opencode-claude-memory entry; plugin options on that entry are kept.
set -euo pipefail

REPO_URL="https://github.com/mattcarvercom/opencode-claude-memory.git"
dir=""
config=""
edit_config=1

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) dir="$2"; shift 2 ;;
        --config) config="$2"; shift 2 ;;
        --no-config) edit_config=0; shift ;;
        -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]:-/dev/null}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v bun >/dev/null || { echo "bun is required (https://bun.sh)" >&2; exit 1; }

# A checkout containing this script is used as is. Piped into bash
# (curl ... | bash) there is no script file, so it clones instead.
source_file="${BASH_SOURCE[0]:-}"
if [ -z "$dir" ] && [ -f "$source_file" ]; then
    script_dir="$(cd "$(dirname "$source_file")" && pwd)"
    if [ -f "$script_dir/../package.json" ] && grep -q '"name": "opencode-claude-memory"' "$script_dir/../package.json"; then
        dir="$(cd "$script_dir/.." && pwd)"
    fi
fi
dir="${dir:-$HOME/.local/share/opencode-claude-memory}"

if [ -d "$dir/.git" ]; then
    echo "Updating $dir"
    git -C "$dir" pull --ff-only
else
    echo "Cloning into $dir"
    mkdir -p "$(dirname "$dir")"
    git clone "$REPO_URL" "$dir"
fi

echo "Building"
(cd "$dir" && bun install --frozen-lockfile && bun run build)

entry="file://$dir"
if [ "$edit_config" -eq 0 ]; then
    echo "Done. Add this to the \"plugin\" list in your opencode config: \"$entry\""
    exit 0
fi

if [ -z "$config" ]; then
    config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
    config="$config_dir/opencode.json"
    [ -e "$config" ] || [ ! -e "$config_dir/opencode.jsonc" ] || config="$config_dir/opencode.jsonc"
fi

ENTRY="$entry" CONFIG="$config" bun -e '
const fs = require("node:fs")
const path = require("node:path")
const { ENTRY: entry, CONFIG: file } = process.env
const isOurs = (spec) => typeof spec === "string" && (spec === entry || /^opencode-claude-memory(@|$)/.test(spec))
const nameOf = (item) => (Array.isArray(item) ? item[0] : item)

if (!fs.existsSync(file)) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const config = { $schema: "https://opencode.ai/config.json", plugin: [entry] }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Created ${file}`)
  process.exit(0)
}

const text = fs.readFileSync(file, "utf8")
const config = Bun.JSONC.parse(text)
const plugins = Array.isArray(config.plugin) ? config.plugin : []
const ours = plugins.filter((item) => isOurs(nameOf(item)))
if (ours.length === 1 && nameOf(ours[0]) === entry) {
  console.log(`${file} already loads ${entry}`)
  process.exit(0)
}

let strict = true
try {
  JSON.parse(text)
} catch {
  strict = false
}

if (strict) {
  // Plain JSON: rewrite it, keeping options on an existing entry.
  const kept = plugins.filter((item) => !isOurs(nameOf(item)))
  const previous = ours.find(Array.isArray)
  config.plugin = [...kept, previous ? [entry, ...previous.slice(1)] : entry]
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Updated ${file}`)
  process.exit(0)
}

// JSONC with comments: change only the entry'"'"'s string, so comments survive.
const names = [...new Set(ours.map(nameOf))]
if (names.length === 1) {
  const literal = JSON.stringify(names[0])
  if (text.split(literal).length === 2) {
    fs.writeFileSync(file, text.replace(literal, JSON.stringify(entry)))
    console.log(`Updated ${file}`)
    process.exit(0)
  }
}
console.log(`Could not edit ${file} safely (it has comments). Add "${entry}" to its "plugin" list, replacing any opencode-claude-memory entry.`)
process.exit(3)
'

echo "Done. Restart opencode to load the plugin."
