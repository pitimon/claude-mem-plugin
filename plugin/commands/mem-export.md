# /mem-export - Export Memories to Markdown

You are a memory export assistant. The user wants to export their claude-mem memories to portable markdown format.

## Input
The user provided: `$ARGUMENTS`

## Task

1. **Parse the input** to extract options:
   - `--since=<period>` or `-s <period>`: Export only recent (e.g., 7d, 30d, 1w, 1m)
   - `--type=<type>` or `-t <type>`: Filter by type (decision, bugfix, discovery, feature, change)
   - `--project=<name>` or `-p <name>`: Filter by project
   - `--format=<fmt>` or `-f <fmt>`: Output format (markdown, json) - default: markdown
   - `--output=<dir>` or `-o <dir>`: Output directory - default: ./claude-mem-export
   - `--limit=<n>` or `-l <n>`: Max observations to export - default: 100

2. **Query observations** using sqlite3:

```bash
# Build query based on filters
sqlite3 -json ~/.claude-mem/claude-mem.db "
SELECT
  id, type, title, subtitle, narrative, concepts,
  files_read, files_modified, created_at, project
FROM observations
WHERE 1=1
  [AND type = '<type>' if --type specified]
  [AND created_at >= '<date>' if --since specified]
  [AND project LIKE '%<project>%' if --project specified]
ORDER BY created_at DESC
LIMIT <limit>
"
```

3. **Create export directory structure**:

```
<output>/
├── YYYY-MM/
│   ├── decisions.md      # Type-grouped files
│   ├── discoveries.md
│   ├── bugfixes.md
│   ├── features.md
│   └── changes.md
├── index.md              # Overview with stats and links
└── metadata.json         # Export metadata
```

4. **Generate markdown files** with this format:

### For type-grouped files (e.g., decisions.md):

```markdown
# Decisions - January 2026

## [#12345] Decision Title Here
**Date:** Jan 10, 2026 10:30 AM
**Project:** project-name

### Summary
The narrative/description text here...

### Key Points
- Fact 1 from facts array
- Fact 2 from facts array

### Related
- **Concepts:** concept1, concept2, concept3
- **Files:** file1.ts, file2.md

---
```

### For index.md:

```markdown
# Claude-Mem Export

**Exported:** YYYY-MM-DD HH:MM
**Total Observations:** XXX
**Date Range:** Start - End

## Statistics

| Type | Count |
|------|-------|
| decision | XX |
| discovery | XX |
| bugfix | XX |
| feature | XX |
| change | XX |

## Contents

### 2026-01
- [Decisions](./2026-01/decisions.md) (X entries)
- [Discoveries](./2026-01/discoveries.md) (X entries)
...
```

5. **Handle --format=json**:

If JSON format requested, export as single file:
```json
{
  "exported_at": "2026-01-13T00:00:00Z",
  "total": 100,
  "filters": { "since": "7d", "type": null },
  "observations": [...]
}
```

6. **Report results**:

```
Export Complete!

Location: ./claude-mem-export/
Total: 85 observations exported
Files created:
  - index.md
  - 2026-01/decisions.md (12 entries)
  - 2026-01/discoveries.md (45 entries)
  - 2026-01/bugfixes.md (8 entries)
  - metadata.json
```

## Usage Help (show when --help)

```
/mem-export - Export memories to portable markdown

Usage:
  /mem-export                           Export last 100 observations
  /mem-export --since=30d               Last 30 days
  /mem-export --type=decision           Only decisions
  /mem-export --project=myapp           Specific project
  /mem-export --format=json             JSON format
  /mem-export --output=./backup         Custom output directory
  /mem-export --limit=500               Export more observations

Options:
  --since, -s     Time filter: 1d, 7d, 30d, 1w, 1m
  --type, -t      Type: decision, bugfix, discovery, feature, change
  --project, -p   Filter by project name
  --format, -f    Output format: markdown (default), json
  --output, -o    Output directory (default: ./claude-mem-export)
  --limit, -l     Max observations (default: 100)

Examples:
  /mem-export --since=7d --type=decision
  /mem-export --project=claude-mem --limit=200
  /mem-export --format=json --output=./backup
```

## Example

**Input**: `/mem-export --since=7d --type=decision`

**Steps**:
1. Calculate date: 7 days ago = 2026-01-06
2. Query: `SELECT ... FROM observations WHERE type='decision' AND created_at >= '2026-01-06' LIMIT 100`
3. Create directory: `./claude-mem-export/`
4. Generate files: `index.md`, `2026-01/decisions.md`, `metadata.json`

**Output**:
```
Export Complete!

Location: ./claude-mem-export/
Total: 8 decisions exported (last 7 days)

Files created:
  - index.md (overview)
  - 2026-01/decisions.md (8 entries)
  - metadata.json

View your export: cat ./claude-mem-export/index.md
```

## Important Notes

- Always execute the sqlite3 query and file creation - don't just explain
- Create directories if they don't exist using mkdir -p
- Use Write tool for creating markdown files
- Format dates in human-readable format
- Escape special markdown characters in content
- Show progress for large exports
- Handle empty results gracefully
