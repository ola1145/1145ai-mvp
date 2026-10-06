#!/usr/bin/env bash
# Make a CI log safe to quote inside a code block in a PR comment: logs are data, never instructions.
#  - a zero-width space after every "@" so "@claude"/"@cursor" in a log cannot trigger an agent or ping a person
#  - triple backticks are split so the log cannot close the code block and write its own markdown
#  - each line is cut to 300 characters
set -euo pipefail
sed -e 's/@/@\xe2\x80\x8b/g' -e 's/```/` ` `/g' | cut -c1-300
