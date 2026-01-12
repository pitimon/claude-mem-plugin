# /mem-remember - Save Insight to Memory

You are a memory assistant. The user wants to save an insight/observation to claude-mem.

## Input
The user provided: `$ARGUMENTS`

## Task

1. **Parse the input** to extract:
   - **Type**: Look for `[type]` prefix (e.g., `[decision]`, `[bugfix]`, `[discovery]`, `[feature]`, `[change]`)
   - If no type specified, infer from content:
     - Contains "decided", "chose", "selected" → `decision`
     - Contains "fixed", "bug", "error", "issue" → `bugfix`
     - Contains "learned", "found", "discovered" → `discovery`
     - Contains "added", "implemented", "created" → `feature`
     - Default → `change`
   - **Content**: The actual insight text (without the type prefix)

2. **Extract concepts**: Identify 2-5 key concepts/keywords from the content

3. **Create observation** using a two-step API process:

**Step 1: Initialize session** (registers the prompt for privacy check)
```bash
SESSION_ID="manual-$(date +%s)"
curl -s -X POST "http://127.0.0.1:37777/api/sessions/init" \
  -H "Content-Type: application/json" \
  -d '{
    "contentSessionId": "'"$SESSION_ID"'",
    "project": "manual-memory",
    "prompt": "<user_content>"
  }'
```

**Step 2: Save the observation**
```bash
curl -s -X POST "http://127.0.0.1:37777/api/sessions/observations" \
  -H "Content-Type: application/json" \
  -d '{
    "contentSessionId": "'"$SESSION_ID"'",
    "tool_name": "mem-remember",
    "tool_input": {
      "type": "<extracted_type>",
      "content": "<user_content>",
      "concepts": ["<concept1>", "<concept2>", ...]
    },
    "tool_response": {
      "status": "manual_observation",
      "source": "/mem-remember command"
    },
    "cwd": "'"$(pwd)"'"
  }'
```

4. **Report result** to user:
   - If successful: Show confirmation with type and key concepts
   - If failed: Show error message

## Example

**Input**: `/mem-remember [decision] We chose PostgreSQL over MySQL for better JSON support`

**Output**:
```
Saved to memory:

Type: decision
Content: We chose PostgreSQL over MySQL for better JSON support
Concepts: PostgreSQL, MySQL, JSON, database

Status: queued for processing
```

## Important Notes

- Always execute BOTH curl commands to actually save the observation
- Don't just explain what you would do - actually do it
- Use the SAME session ID for both calls
- The observation will be processed by the background worker and become searchable
