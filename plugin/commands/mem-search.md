# /mem-search - Search Memory

You are a memory search assistant. The user wants to search their claude-mem memory database.

## Input
The user provided: `$ARGUMENTS`

## Task

1. **Parse the input** to extract:
   - **Query**: The main search terms (everything that's not a flag)
   - **Optional filters** (if present):
     - `--type=<type>` or `-t <type>`: Filter by observation type (decision, bugfix, discovery, feature, change)
     - `--since=<period>` or `-s <period>`: Filter by time (e.g., 7d, 30d, 1w, 1m)
     - `--project=<name>` or `-p <name>`: Filter by project name
     - `--limit=<n>` or `-l <n>`: Number of results (default: 10)

2. **Convert time filters** to dateStart format:
   - `7d` → 7 days ago
   - `30d` → 30 days ago
   - `1w` → 7 days ago
   - `1m` → 30 days ago
   - Use ISO 8601 format: YYYY-MM-DD

3. **Execute search** using the MCP search tool:

Use the `mcp__plugin_claude-mem_mcp-search__search` tool with these parameters:
- `query`: The extracted search query
- `limit`: Number of results (default 10)
- `type`: If --type was specified
- `dateStart`: If --since was specified (converted to date)
- `project`: If --project was specified

4. **Format results** in a readable table:

```markdown
## Search Results for: "<query>"

| ID | Date | Type | Title |
|----|------|------|-------|
| #123 | Jan 10 | decision | Title here... |
| #124 | Jan 09 | bugfix | Another title... |

Found X results. Use `/mem-search --help` for filter options.
```

5. **Handle edge cases**:
   - If no results: "No memories found matching '<query>'"
   - If query is empty: Show usage help
   - If `--help` flag: Show full usage documentation

## Usage Help (show when --help or no query)

```
/mem-search - Search your memory database

Usage:
  /mem-search <query>                    Basic search
  /mem-search <query> --type=decision    Filter by type
  /mem-search <query> --since=7d         Last 7 days only
  /mem-search <query> --project=myapp    Filter by project
  /mem-search <query> --limit=20         Get more results

Filters:
  --type, -t     Filter by type: decision, bugfix, discovery, feature, change
  --since, -s    Time filter: 1d, 7d, 30d, 1w, 1m
  --project, -p  Filter by project name
  --limit, -l    Number of results (default: 10)

Examples:
  /mem-search kubernetes deployment
  /mem-search authentication --type=decision
  /mem-search debugging --since=7d
  /mem-search api --project=claude-mem --limit=20
```

## Example

**Input**: `/mem-search kubernetes errors --type=bugfix --since=7d`

**Parsed**:
- Query: "kubernetes errors"
- Type: bugfix
- Since: 7 days ago (2026-01-06)
- Limit: 10 (default)

**MCP Call**:
```
mcp__plugin_claude-mem_mcp-search__search({
  query: "kubernetes errors",
  type: "bugfix",
  dateStart: "2026-01-06",
  limit: 10
})
```

**Output**:
```
## Search Results for: "kubernetes errors"

| ID | Date | Type | Title |
|----|------|------|-------|
| #31250 | Jan 10 | bugfix | Fixed Kubernetes pod restart loop |
| #31198 | Jan 08 | bugfix | Resolved K8s service discovery issue |

Found 2 results matching "kubernetes errors" (bugfix, last 7 days)
```

## Important Notes

- Always execute the MCP search tool - don't just explain what you would do
- Format dates in human-readable format (Jan 10, not 2026-01-10)
- Truncate long titles to ~50 chars with "..."
- Show the search criteria used in the results summary
- If search returns many results, suggest using filters to narrow down
