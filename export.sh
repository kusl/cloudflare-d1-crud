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

# 3. Clear the output file
: > "$OUTPUT_FILE"

echo "Processing files from Git index..."

# 4. Loop through files in the git index
git ls-files | while read -r file; do
    
    # --- EXCLUSIONS ---
    # Skip the output file, lock files, and other noise
    if [[ "$file" == "$OUTPUT_FILE" ]] || \
       [[ "$file" == "yarn.lock" ]] || \
       [[ "$file" == "package-lock.json" ]]; then
        echo "Skipping excluded file: $file"
        continue
    fi

    # Check if the file exists locally
    if [ -f "$file" ]; then
        
        # Check if the file is binary
        if grep -Iq . "$file" 2>/dev/null || [ ! -s "$file" ]; then
            {
                echo "================================================================================"
                echo "FILE PATH: $file"
                echo "================================================================================"
                cat "$file"
                echo -e "\n" 
            } >> "$OUTPUT_FILE"
            echo "Added: $file"
        else
            echo "Skipped Binary: $file"
        fi
    fi
done

echo "------------------------------------------------"
echo "Success! Content dumped to: $OUTPUT_FILE"




