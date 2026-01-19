# sl-cli

Minimal CLI for SL Journey Planner and Transport APIs.

## Install (local)

```bash
npm install
npm run build
```

## Usage

```bash
# Set default origin
sl-cli config set origin "Odenplan"

# Plan a trip (depart now)
sl-cli plan --to "Slussen"

# Plan a trip with arrival time
sl-cli plan --to "Slussen" --arrive "2026-01-17 12:00"

# Next departures
sl-cli next --stop "Tekniska hogskolan"
```

## Output modes

- Default: human output when TTY
- `--json`: JSON output
- `--plain`: line-based text output

## Config

Config file: `~/.config/sl-cli/config.json`

Keys:
- `origin`
- `home`
- `work`
- `timezone`
