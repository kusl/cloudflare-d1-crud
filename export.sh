#!/bin/bash

# Configuration
OUTPUT_DIR="docs/llm"
OUTPUT_FILE="${OUTPUT_DIR}/dump.txt"

# 1. Check if we are inside a git repository
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo "Error: You are not inside a git repository."
    exit 1
fi

# 2. Create the directory if it doesn't exist
if [ ! -d "$OUTPUT_DIR" ]; then
    echo "Creating directory $OUTPUT_DIR..."
    mkdir -p "$OUTPUT_DIR"
fi

# 3. Clear the output file if it exists, or create an empty one
: > "$OUTPUT_FILE"

echo "Processing files from Git index..."

# 4. Loop through files in the git index
git ls-files | while read -r file; do
    
    # Skip the output file itself if it happens to be tracked
    if [[ "$file" == "$OUTPUT_FILE" ]]; then
        continue
    fi

    # Check if the file exists locally (safety check)
    if [ -f "$file" ]; then
        
        # Check if the file is binary (don't dump binary content like images)
        # grep -I treats binary files as non-matches
        if grep -Iq . "$file" 2>/dev/null || [ ! -s "$file" ]; then
            {
                echo "================================================================================"
                echo "FILE PATH: $file"
                echo "================================================================================"
                cat "$file"
                echo -e "\n" # Add extra spacing between files
            } >> "$OUTPUT_FILE"
            echo "Added: $file"
        else
            echo "Skipped Binary: $file"
        fi
    fi
done

echo "------------------------------------------------"
echo "Success! Content dumped to: $OUTPUT_FILE"
