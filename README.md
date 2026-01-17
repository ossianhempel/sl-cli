# sl-clie

Minimal CLI for SL Journey Planner and Transport APIs.

## Install (local)

```bash
npm install
npm run build
```

## Usage

```bash
# Set default origin
sl-clie config set origin "Odenplan"

# Plan a trip (depart now)
sl-clie plan --to "Slussen"

# Plan a trip with arrival time
sl-clie plan --to "Slussen" --arrive "2026-01-17 12:00"

# Next departures
sl-clie next --stop "Tekniska hogskolan"
```

## Output modes

- Default: human output when TTY
- `--json`: JSON output
- `--plain`: line-based text output

## Config

Config file: `~/.config/sl-clie/config.json`

Keys:
- `origin`
- `home`
- `work`
- `timezone`
