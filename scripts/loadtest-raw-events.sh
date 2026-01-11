#!/bin/bash
# Load test for Option C: Raw First, Summarize Later

WORKER_URL="http://localhost:37777"
SESSION_ID=72841
CONTENT_SESSION_ID="163a84a4-345a-4213-853c-a1d4fa5baff3"
COUNT=${1:-20}

echo "=== Option C Load Test ==="
echo "Sending $COUNT observations rapidly..."

# Get initial counts
INITIAL=$(sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM raw_tool_events")
echo "Initial raw_tool_events count: $INITIAL"
echo ""

# Send observations rapidly
START=$(python3 -c "import time; print(int(time.time()*1000))")
for i in $(seq 1 $COUNT); do
  curl -s -X POST "$WORKER_URL/api/sessions/observations" \
    -H "Content-Type: application/json" \
    -d "{\"sessionDbId\":$SESSION_ID,\"contentSessionId\":\"$CONTENT_SESSION_ID\",\"tool_name\":\"LoadTest\",\"tool_input\":{\"id\":$i},\"tool_response\":{\"ok\":true},\"prompt_number\":100}" &
done
wait
END=$(python3 -c "import time; print(int(time.time()*1000))")
DURATION=$((END - START))

echo "Sent $COUNT observations in ${DURATION}ms"

# Check immediate capture
sleep 2
PENDING=$(sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM raw_tool_events WHERE status = 'pending' AND tool_name = 'LoadTest'")
SUMMARIZING=$(sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM raw_tool_events WHERE status = 'summarizing' AND tool_name = 'LoadTest'")
echo "After 2s: pending=$PENDING, summarizing=$SUMMARIZING"

# Wait for summarization
echo ""
echo "Waiting for summarization..."
for sec in 10 20 30; do
  sleep 10
  sqlite3 ~/.claude-mem/claude-mem.db "SELECT status, COUNT(*) as cnt FROM raw_tool_events WHERE tool_name = 'LoadTest' GROUP BY status" | while read line; do
    echo "  After ${sec}s: $line"
  done
done

# Final summary
echo ""
echo "=== Final Results ==="
sqlite3 ~/.claude-mem/claude-mem.db "SELECT status, COUNT(*) as count FROM raw_tool_events WHERE tool_name = 'LoadTest' GROUP BY status"
TOTAL=$(sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM raw_tool_events WHERE tool_name = 'LoadTest'")
COMPLETED=$(sqlite3 ~/.claude-mem/claude-mem.db "SELECT COUNT(*) FROM raw_tool_events WHERE tool_name = 'LoadTest' AND status = 'completed'")
echo ""
echo "Captured: $TOTAL / $COUNT"
echo "Completed: $COMPLETED / $COUNT"
