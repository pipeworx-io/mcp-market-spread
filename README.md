# mcp-market-spread

market-spread MCP — cross-venue prediction-market landscape scanner.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Market Spread data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
