# Kiro CLI Full Command Reference

Binary: `kiro-cli` (at `~/.local/bin/kiro-cli`)

## Top-level commands

```text
chat          AI assistant in your terminal
agent         Agent root commands
doctor        Fix and diagnose common issues
settings      Customize appearance & behavior
login         Login
logout        Logout
whoami        Prints details about the current user
profile       Show the profile associated with this idc user
mcp           Model Context Protocol (MCP)
acp           Agent Client Protocol (ACP)
translate     Natural Language to Shell translation
launch        Launch the desktop app
quit          Quit the app
restart       Restart the desktop app
update        Update the Kiro application
```

---

## Task execution / coding

### One-shot (non-interactive)

```bash
kiro-cli chat --no-interactive --trust-all-tools 'Your task here'
```

### One-shot with specific agent

```bash
kiro-cli chat --agent NAME --no-interactive --trust-all-tools 'Your task here'
```

### ACP (programmatic multi-turn)

```bash
kiro-cli acp --agent backend-specialist --model claude-opus-4.6 --trust-all-tools
```

---

## Session management

```bash
kiro-cli chat --list-sessions
kiro-cli chat --resume
kiro-cli chat --resume-picker
kiro-cli chat --delete-session <SESSION_ID>
```

---

## Custom agent management

```bash
kiro-cli agent list
kiro-cli agent create <NAME>
kiro-cli agent edit <NAME>
kiro-cli agent validate <FILE>
kiro-cli agent set-default <NAME>
```

---

## Settings

```bash
kiro-cli settings list                          # List configured settings
kiro-cli settings list --all                    # List all settings with descriptions
kiro-cli settings <KEY>                         # View one setting
kiro-cli settings <KEY> <VALUE>                 # Set one setting
kiro-cli settings --delete <KEY>                # Delete one setting
kiro-cli settings open                          # Open settings file
kiro-cli settings open --workspace              # Open workspace settings
```

### Key settings

```bash
# Model
kiro-cli settings chat.defaultModel
kiro-cli settings chat.defaultModel 'claude-opus-4.6'
kiro-cli settings --delete chat.defaultModel

# Default agent
kiro-cli settings chat.defaultAgent
kiro-cli settings chat.defaultAgent 'backend-specialist'
kiro-cli settings --delete chat.defaultAgent

# Feature toggles
kiro-cli settings chat.enableKnowledge true
kiro-cli settings chat.enableThinking true
kiro-cli settings chat.enableTangentMode true
kiro-cli settings chat.enableTodoList true
kiro-cli settings chat.enableCheckpoint true
```

Also supported in interactive Kiro chat: `/model`, `/model MODEL_ID`, `/model set-current-as-default`, `/context`, `/agent`, `/mcp`

---

## Account / auth / identity

```bash
kiro-cli login
kiro-cli logout
kiro-cli whoami
kiro-cli profile
```

---

## Diagnostics

```bash
kiro-cli doctor
kiro-cli diagnostic
kiro-cli debug
kiro-cli setup
```

---

## MCP

```bash
kiro-cli mcp list
kiro-cli mcp list workspace
kiro-cli mcp status --name SERVER_NAME
kiro-cli mcp add --name NAME --command COMMAND --args ARG1 --args ARG2
kiro-cli mcp add --name NAME --url URL
kiro-cli mcp remove --name NAME
kiro-cli mcp import --file ./mcp.json workspace
```

---

## Shell / integrations

```bash
kiro-cli translate 'find all large files under this directory'
kiro-cli setup
kiro-cli setup --dotfiles
kiro-cli setup --input-method
kiro-cli integrations status
kiro-cli integrations install
kiro-cli integrations uninstall
kiro-cli integrations reinstall
```

---

## Desktop lifecycle

```bash
kiro-cli launch
kiro-cli quit
kiro-cli restart
kiro-cli update
```

Confirm before disruptive lifecycle commands.

---

## Exec parameters for OpenClaw

| Parameter | Use |
| --- | --- |
| `command` | Actual Kiro CLI command |
| `workdir` | Project directory Kiro should operate in |
| `background:true` | For long-running Kiro work |
| `timeout` | Bounded foreground execution |

## OpenClaw process actions

| Action | Meaning |
| --- | --- |
| `list` | Show running/recent processes |
| `log` | Read Kiro stdout/stderr |
| `poll` | Check whether process is still running |
| `write` | Send raw text |
| `submit` | Send text + Enter |
| `send-keys` | Send terminal keys |
| `kill` | Stop the process |

---

## Confidence notes

### Verified locally (from `kiro-cli --help`)
All top-level commands listed above.

### Confirmed from docs/search
- `--no-interactive`, `--trust-all-tools`, `--resume`, `--resume-picker`, `--list-sessions`, `--delete-session`, `--agent NAME`
- `agent list`, `settings list --all`, `settings open`

If a subcommand's exact flags are mission-critical for a write action, verify with live command help before executing.
