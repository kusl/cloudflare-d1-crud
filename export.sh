#!/bin/bash

# Configuration
OUTPUT_DIR="docs/llm"
OUTPUT_FILE="${OUTPUT_DIR}/dump.txt"

# 1. Check if we are inside a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "Error: You are not inside a git repository."
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
: > "$OUTPUT_FILE"

echo "Processing files from Git index..."
FILE_COUNT=0

# 4. Loop through files in the git index
# Added 'docs/llm/commands.txt' and 'docs/llm/output.txt' to exclusion
git ls-files | while read -r file; do
    
    if [[ "$file" == "$OUTPUT_FILE" ]] || \
       [[ "$file" == "yarn.lock" ]] || \
       [[ "$file" == "package-lock.json" ]] || \
       [[ "$file" == "docs/llm/commands.txt" ]] || \
       [[ "$file" == "docs/llm/output.txt" ]]; then
        continue
    fi

    if [ -f "$file" ]; then
        if grep -Iq . "$file" 2>/dev/null || [ ! -s "$file" ]; then
            {
                echo "================================================================================"
                echo "FILE PATH: $file"
                echo "================================================================================"
                cat "$file"
                echo -e "\n" 
            } >> "$OUTPUT_FILE"
            ((FILE_COUNT++))
            echo "Added: $file"
        fi
    fi
done

# Stats for your LLM context management
CHAR_COUNT=$(wc -m < "$OUTPUT_FILE")
echo "------------------------------------------------"
echo "Success! $FILE_COUNT files dumped to: $OUTPUT_FILE"
echo "Total Character Count: $CHAR_COUNT"
echo "------------------------------------------------"
