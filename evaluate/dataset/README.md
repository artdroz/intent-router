# Evaluation Plan

Construct datasets by fetching issues from GitHub issues and PRs with real-world labels and contents.

- Diversity
  - Languages: across 3–5 popular languages
  - Labels count: with 1 (binary) to 8
  - Domain: web frameworks, CLI tools, developer infrastructure, and end-user apps
  - Issue template: include ones with strict metadata and unstructured text
  - Size: huge to medium
- Data Volume
    - 4 repos
    - Validation set: 20 items per label
    - Test set: 50 items per label
- Others: LLM Generated Data for liteLLM Baseline
    - Labels: code generation, analytical reasoning, writing, factual lookup, or general