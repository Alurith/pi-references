# pi-references

`pi-references` is a [Pi](https://github.com/earendil-works/pi-coding-agent) extension that implements OpenCode-style **references** in Pi.

It lets you configure external directories and Git repositories by alias, then use them in the Pi prompt with the same style as OpenCode:

```text
@docs
@sdk/src/client.ts
```

The goal is to bring the behavior described in OpenCode's references documentation to Pi: named project references, autocomplete, local directory support, Git repository materialization, descriptions for agent context, and hidden references.

## Features

- OpenCode-style syntax:
  - `@alias`
  - `@alias/path/to/file`
- Local directory references
- Git repository references
- Global and project-level configuration
- JSON and JSONC config files
- `description` support: described references are injected into the agent context
- `hidden` support: hidden references do not appear in autocomplete but can still be used manually
- Autocomplete for reference aliases
- File browsing autocomplete inside reference directories
- Input expansion to resolved filesystem paths
- Git repository cache under Pi's agent directory (`~/.pi/agent/cache/references/` by default)

## Compatibilità

- Pi **0.85.x**: da **0.85.0** fino a prima di **0.86.0**
- Node.js **>=22.19.0**, come richiesto da Pi 0.85.x

L'estensione usa `CONFIG_DIR_NAME` e `getAgentDir()` esportati da Pi. I percorsi
`.pi` e `~/.pi/agent` riportati sotto sono quindi i valori predefiniti.

## Installation

### Install from GitHub with Pi

Install directly from this repository with Pi:

```bash
pi install git:github.com/Alurith/pi-references
```

Or project-local:

```bash
pi install -l git:github.com/Alurith/pi-references
```

You can also use the HTTPS URL form:

```bash
pi install https://github.com/Alurith/pi-references
```

Then restart Pi, or run `/reload` if the extension is already discoverable in the current session.

### Install from npm with Pi

If published to npm as `pi-references`:

```bash
pi install npm:pi-references
```

If published as a scoped package, for example `@alurith/pi-references`:

```bash
pi install npm:@alurith/pi-references
```

Project-local:

```bash
pi install -l npm:@alurith/pi-references
```

### Local development / quick test

Install runtime dependencies first:

```bash
npm install
npm run check
npm test
```

Then, from a project where you want to test the extension:

```bash
pi -e /absolute/path/to/pi-references/index.ts
```

For example:

```bash
pi -e /home/alessandro/Work/tries/pi-references/index.ts
```

### Local package install

Global:

```bash
pi install /absolute/path/to/pi-references
```

Project-local:

```bash
pi install -l /absolute/path/to/pi-references
```

## Important note about `npm install`

Running:

```bash
npm install Alurith/pi-references
```

or:

```bash
npm install @alurith/pi-references
```

only installs the package into a Node project. It does **not** automatically register the extension with Pi.

To make Pi load the extension, use `pi install ...`, or load it explicitly with `pi -e ...`.

## Configuration

`pi-references` reads configuration from both global and project locations. Project-local configuration is loaded only when Pi trusts the current project.

### Project config

```text
.pi/references.json
.pi/references.jsonc
```

(`.pi` è la project config directory predefinita di Pi.)

Relative paths in project config are resolved from the project root.

### Global config

```text
~/.pi/agent/references.json
~/.pi/agent/references.jsonc
```

(`~/.pi/agent` è l'agent directory predefinita di Pi; può essere modificata
tramite `PI_CODING_AGENT_DIR`.)

Relative paths in global config are resolved from `~/.pi/agent`.

### Merge behavior

Global references are always loaded. Project references are loaded only for trusted projects.

If the same alias exists in both places, the project reference overrides the global one.

## Config format

### Local directory reference

```jsonc
{
  "references": {
    "docs": {
      "path": "../product-docs",
      "description": "Use for product behavior and documentation conventions"
    }
  }
}
```

### Git repository reference

```jsonc
{
  "references": {
    "sdk": {
      "repository": "OWNER/sdk-repo",
      "branch": "main",
      "description": "Use for SDK implementation details"
    }
  }
}
```

`repository` accepts:

- GitHub shorthand: `owner/repo`
- HTTPS Git URL
- SSH Git URL
- local Git repository path

Git repositories are cloned into:

```text
~/.pi/agent/cache/references/
```

Il percorso effettivo segue l'agent directory restituita da Pi.

Git repositories are materialized in the background when the session starts. Missing repositories are cloned with depth 1 and only the selected branch; existing cached checkouts are refreshed shallowly. Startup does not wait for Git, but using a reference while its operation is still running waits for that reference to become available.

### Shorthand syntax

Like OpenCode, string shorthand is supported:

```jsonc
{
  "references": {
    "docs": "../docs",
    "sdk": "OWNER/sdk-repo"
  }
}
```

String values that point to an existing local path are treated as `path`. Otherwise, values that look like Git references are treated as `repository`; other strings are treated as local `path`.

### Hidden references

```jsonc
{
  "references": {
    "internal": {
      "path": "../internal-docs",
      "description": "Use for internal implementation details",
      "hidden": true
    }
  }
}
```

A hidden reference:

- does not appear in autocomplete
- can still be used manually as `@internal` or `@internal/file.md`
- is still added to agent context if it has a `description`

## Managing references

Add a project reference directly from Pi:

```text
/references add sdk OWNER/sdk-repo main
/references add docs ../product-docs
```

Use `--global` to write the global configuration instead:

```text
/references add --global sdk OWNER/sdk-repo main
```

The command writes `.pi/references.json`/`.jsonc` (or the global equivalent) and tells you to run `/reload`. It does not reload the extension automatically.

## Usage

Type `@` in the Pi prompt to see configured references.

Examples:

```text
Compare the current implementation with @sdk/src/client.ts
```

```text
Use @docs to check the product behavior before changing this flow
```

When a reference is used, the extension expands it with its resolved filesystem path before the model receives the prompt. If its background clone or refresh is still running, input waits for that reference. The `[resolved: ...]` suffix is added only after the checkout has been verified or cloned successfully:

```text
@sdk/src/client.ts [resolved: /home/user/.pi/agent/cache/references/sdk-abc123/src/client.ts]
```

If materialization fails, the original reference is left unchanged and an error is reported. This keeps the user-facing syntax close to OpenCode while still giving Pi's tools a real path to inspect.

## Agent context

References with a `description` are added to the system prompt, for example:

```text
Available references:
- docs -> /home/user/product-docs
  Use for product behavior and documentation conventions
- sdk -> /home/user/.pi/agent/cache/references/sdk-abc123
  Use for SDK implementation details
```

References without `description` remain usable through `@alias`, but are not advertised to the agent automatically.

## Alias rules

Reference aliases:

- start with an ASCII letter or digit
- may contain only ASCII letters, digits, `.`, `_`, and `-`
- cannot contain `/`, backslashes, whitespace, or punctuation such as `!`

## Current status

Implemented:

- local references
- Git references
- global + project config
- project config loaded only when Pi trusts the project
- JSON + JSONC comments/trailing commas
- `description`
- `hidden`
- additive alias autocomplete that keeps Pi's native `@` file completion
- file autocomplete inside references with path escape protection
- background Git materialization and shallow refresh at session start
- depth-1, single-branch Git clone
- atomic Git clone into cache
- cache checkout origin validation before reuse
- input expansion to `[resolved: /real/path]` only for available paths
- realpath-based symlink boundary protection
- cancellable Git work on session shutdown
- shared tokenizer for autocomplete and input expansion

Not implemented yet:

- explicit manual Git sync command
- persistent file index/cache
- recursive parent-directory config discovery
- permission boundary changes

## Development

This package is a Pi extension package. The package manifest declares:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

So Pi can install and load it directly with `pi install`.

## License

MIT. See [LICENSE](./LICENSE).
