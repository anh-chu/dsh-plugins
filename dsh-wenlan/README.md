# dsh-wenlan

A local DeepSeek Harness profile bundle for Wenlan.

This bundle connects DSH to the running Wenlan MCP server over stdio. It
exposes the read tools plus the mutation tools needed by the explicit Wenlan
workflows under the `mcp__wenlan__*` namespace.

It registers `/capture`, `/recall`, `/brief`, `/distill`, `/pages`, `/lint`, and
`/curate` commands. The prompt context resolves the session workspace against
`~/.wenlan/spaces.toml` and tells the model which `space` to pass. Unmapped
sessions use `work`. Recall is performed by `/recall`, `/brief`, and the
capture workflow rather than before every model request. A Host tool guard
rejects missing or mismatched Space arguments on scope-bearing Wenlan calls.
Capture guidance is proactive for durable project knowledge, while destructive
operations require the matching workflow and explicit confirmation.

It does not replace or modify `dsh-mneme`; the two memory systems remain
separate.

The bundle targets DSH `0.1.5-rc.1` and assumes Wenlan is installed at
`/home/sil/.wenlan/bin/wenlan-mcp` with its daemon on
`http://127.0.0.1:7878`.
