# mcp-market-spread

market-spread MCP — cross-venue prediction-market landscape scanner.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `compare_topic` | Cross-venue prediction-market LANDSCAPE scanner: for one topic, show how 5 venues (Polymarket, Kalshi, Manifold, PredictIt, Futuur) are pricing it side by side and flag divergence. Each venue is queried in parallel; a venue that errors or times out is reported as { reachable: false } and never fails the call. Returns each venue's top matches normalized to { venue, title, implied_probability (0-1 for the main/YES outcome, or null), url, n_outcomes }, plus a divergence summary across venues' top matches. HONESTY: this surfaces WHERE TO LOOK for mispricing — it is NOT an executable-arb tool. A high spread_pp usually reflects different bet shapes, resolution criteria, dates, or thin liquidity, not a real arbitrage. Divergence is only computed when ≥2 venues' top titles share strong token overlap (Jaccard); otherwise divergence is null with a low-match-quality note telling you to compare manually. Verify the questions resolve identically before trading. For executable poly↔kalshi arbitrage (needs order-book depth) use the `polymarket_arbitrage` pack. |
| `venue_quotes` | Single-venue drill-down: fetch one venue's current top 5 matches for a query, each as { title, implied_probability (0-1 or null), url }. Useful after compare_topic to look closer at one venue. Implied probability is the main/YES outcome where available; multi-outcome markets report the top outcome and note it. Keyless. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "market-spread": {
      "url": "https://gateway.pipeworx.io/market-spread/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/market-spread/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Market Spread data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/compare_topic \
  -H 'Content-Type: application/json' \
  -d '{"topic":"bitcoin 100k"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/compare_topic`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
