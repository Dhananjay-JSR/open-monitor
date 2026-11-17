# open-monitor

A self-hosted server that speaks [Perplexity's Monitor API](https://docs.perplexity.ai/docs/monitors/overview). It watches web search results or specific pages on a schedule, asks an LLM whether what it found matters for your goal, and sends the kept changes to a webhook.

Point an existing Monitor API client at your own base URL and it keeps working. You bring the search provider and the LLM. No npm dependencies.

```bash
curl -X POST http://localhost:8787/v1/monitors \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "AI infra funding",
    "targets": [{ "type": "search", "query": "ai infrastructure funding" }],
    "goal": "New funding rounds for GPU cloud and inference companies",
    "schedule": { "type": "interval", "interval": "1d" },
    "webhook": { "url": "https://agent.example.com/hooks/monitor" }
  }'
```

The response (trimmed):

```json
{
  "id": "mon_0mwknsn47w5grwsd3vmxm",
  "object": "monitor",
  "name": "AI infra funding",
  "schedule": { "type": "interval", "interval": "1d" },
  "webhook": {
    "url": "https://agent.example.com/hooks/monitor",
    "events": ["monitor.changes.detected", "monitor.paused"],
    "secret": "whsec_niyxhgiACaH3OI9TZhjLRdanSQf5Guwk"
  },
  "status": "active",
  "next_run_at": "2026-11-18T12:18:55Z"
}
```

## Contents

- [Run it](#run-it)
- [Configuration](#configuration)
- [The judge (LLM)](#the-judge-llm)
- [Search](#search)
- [Pages that need JavaScript](#pages-that-need-javascript)
- [Webhooks](#webhooks)
- [Dashboard](#dashboard)
- [Telemetry](#telemetry)
- [Differences from Perplexity's API](#differences-from-perplexitys-api)
- [Not tested](#not-tested)
- [Development](#development)

## Run it

### Node

Needs Node 24 or newer (it uses the built-in `node:sqlite`).

```bash
cp .env.example .env    # set API_KEY and an LLM, see below
npm start
```

The server listens on port 8787 and stores everything in `monitor.db`. A timer inside the process runs the scheduler once a minute.

### Docker

```bash
cp .env.example .env
docker compose up -d
```

The compose file also starts [SearXNG](https://github.com/searxng/searxng) for search and [Lightpanda](https://github.com/lightpanda-io/browser) for pages that need JavaScript, and wires both in. Change `secret_key` in `searxng/settings.yml` first.

### Cloudflare Workers

```bash
wrangler d1 create open-monitor      # paste the id into wrangler.toml
wrangler secret put API_KEY          # and the other secrets listed in wrangler.toml
wrangler deploy
```

Storage is D1 and the scheduler is a cron trigger that fires every minute. `LLM_COMMAND` does not work here, because Workers cannot start processes.

### Anywhere else

If your host has no long-running process and no cron of its own, have any external cron call the scheduler:

```bash
curl -X POST https://your-host/tick -H "Authorization: Bearer $API_KEY"
```

Calling it more often than needed, or alongside the built-in timer, is harmless. Every job is claimed before it runs.

## Configuration

Everything is an environment variable. `.env.example` lists them all.

| Variable | What it does |
|---|---|
| `API_KEY` | Required. Clients send it as `Authorization: Bearer ...` |
| `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | Judge over an OpenAI-compatible API |
| `LLM_COMMAND` | Judge through a local command instead (Node only) |
| `LLM_REQUESTS_PER_MINUTE` | Most judge calls per minute, shared by every process. Default 20, `0` for no limit |
| `TAVILY_API_KEY` | Search through Tavily |
| `SEARXNG_URL` | Search through your own SearXNG. Wins if both are set |
| `BROWSER_WS_URL` | CDP websocket of a browser, for JavaScript-rendered pages |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD`, `SESSION_SECRET` | Turn the dashboard on (all three are needed) |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` | Telemetry export |
| `ALLOW_PRIVATE_URLS` | Allow webhook and page URLs on localhost and private networks |
| `TRUST_PROXY` | Read the client IP from `X-Forwarded-For` (set it when behind a reverse proxy) |
| `COST_PER_SEARCH_RUN`, `COST_PER_PAGE_FETCH` | Rates for the `usage.cost` field. Default 0 |
| `PORT`, `DB_PATH` | Default `8787` and `monitor.db` |

## The judge (LLM)

Every candidate (a new search result, or a page diff) is scored from 0 to 1 against the monitor's `goal`, one LLM call per candidate. Scores at or above the threshold (0.5, or `judge.threshold` on the target) are kept.

An LLM is required. Without one, every run fails with `judge_failed` and the server prints a warning at startup.

**OpenRouter, free models.** The default, only a key is needed:

```bash
LLM_API_KEY=sk-or-...
```

**OpenAI or any other OpenAI-compatible API:**

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
LLM_MODEL=<a chat model your key can use>
```

**Ollama, fully local.** No key:

```bash
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=<a model you have pulled>
```

**A command line tool.** The server writes the prompt to the command's stdin and reads the answer from stdout, so anything that works as a filter works here. With Claude Code this uses whatever login the CLI already has on that machine:

```bash
LLM_COMMAND="claude -p"
```

The same idea should work with `codex exec` and `opencode run`, or with a script of your own that prints `{"score": 0.8}`.

Judge calls are limited to `LLM_REQUESTS_PER_MINUTE` (default 20, OpenRouter's limit for free models). The count is kept in the database, so all server processes and Cloudflare invocations share it; a call over the limit waits until a slot frees up. Set it to `0` when your key has no limit.

If the provider still answers 429, the server waits for the `Retry-After` it asks for, up to 30 seconds, twice. If the limit holds, it stops judging for that run and the remaining candidates are picked up by the next one.

OpenRouter's free models also have a daily cap: 50 requests a day until you have bought 10 credits, then 1,000. Every candidate costs one call, so a busy search monitor can use up 50 in its first run or two, after which runs fail with `judge_failed` until the next day.

### Using a chat subscription instead of an API key

There are local proxies that log in to a Claude or ChatGPT subscription and expose an OpenAI-compatible endpoint. Since the judge accepts any such endpoint, pointing `LLM_BASE_URL` at one works.

Know what you are doing before you try it: Anthropic's [terms for Claude Code](https://code.claude.com/docs/en/legal-and-compliance) say subscription logins are for Claude Code and Anthropic's own apps, and that routing requests through subscription credentials in other tools is not permitted. Your account carries that risk. `LLM_COMMAND="claude -p"` is the route those terms allow, because it runs the unmodified CLI with your own login.

## Search

Search monitors need one of:

- `TAVILY_API_KEY`: a [Tavily](https://tavily.com) key.
- `SEARXNG_URL`: your own SearXNG with the JSON format enabled (the compose file sets this up).

Each run fetches up to `max_results` results, applies `include_domains` and `exclude_domains`, drops URLs this monitor has already judged, and sends the rest to the judge. A URL is judged once: rejected results do not come back, even if you change the goal later.

## Pages that need JavaScript

Page monitors fetch each URL with a plain HTTP request, which is enough for server-rendered pages. For pages that build their content in the browser, set `BROWSER_WS_URL` to the CDP websocket of a headless browser. The server then loads each page in it and reads the HTML after scripts have run.

```bash
# Lightpanda, started with: lightpanda serve --host 127.0.0.1 --port 9222
BROWSER_WS_URL=ws://127.0.0.1:9222/
```

Anything that speaks CDP should work the same way: Chrome with `--remote-debugging-port`, Browserless, Cloudflare Browser Run, or a self-hosted [Kitesurf](https://github.com/cloudflare/kitesurf). On Node, `BROWSER_WS_HEADERS` (a JSON object) adds headers to the websocket request, for browsers that need a token.

The first run of a page monitor saves a baseline and reports nothing. Later runs report a unified diff of the page text, capped at 24 KiB.

## Webhooks

Events are signed the [Standard Webhooks](https://www.standardwebhooks.com) way, the same as Perplexity's, so existing verification code works. To verify by hand:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verify(rawBody, headers, secret) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const signed = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${rawBody}`
  const expected = 'v1,' + createHmac('sha256', key).update(signed).digest('base64')
  return headers['webhook-signature']
    .split(' ')
    .some((sig) => sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
}
```

Also reject timestamps more than five minutes old, and dedupe on `webhook-id`.

- A failed delivery is retried after 5 seconds, 5 minutes, 30 minutes, 2, 5 and 10 hours. Timeouts, network errors, 408, 429 and 5xx are retried. Other 4xx and redirects are not.
- A delivery that fails for good pauses the monitor with `pause_reason: webhook_failing`. Fix the endpoint, then call `/resume`.
- After you change the secret, the old one keeps signing alongside the new one for 24 hours.
- Webhook and page URLs on localhost or private addresses are refused unless `ALLOW_PRIVATE_URLS=1`. The check looks at the hostname as written, so a public name that resolves to a private address still gets through.

## Dashboard

Set `DASHBOARD_USER`, `DASHBOARD_PASSWORD` and `SESSION_SECRET`, then open the server's root URL. Without all three there is no dashboard and `/` returns 404.

It shows one lane per monitor with its runs over the last 24 hours, and a log of every run with the kept changes, diffs and webhook deliveries. You can create, run, pause, resume and delete monitors from it.

Logins are server-side sessions that last 12 hours. Five wrong passwords lock that username and IP for 15 minutes. Serve it over HTTPS: the session cookie is only marked `Secure` when the request arrived over HTTPS (or with `X-Forwarded-Proto: https`).

## Telemetry

Every webhook attempt is recorded and available at `GET /v1/monitors/{id}/deliveries`, and in the dashboard log.

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to also export traces, counters and logs over OTLP/HTTP (JSON) to any OpenTelemetry backend:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=<your backend's OTLP/HTTP endpoint>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=<value your backend gives you, url-encoded>
```

Hosted backends with a free tier (Grafana Cloud, for one) show both values on their OpenTelemetry setup page.

Each run is one trace: the run itself, the search call or page fetches, each judge call, and each webhook delivery attempt. Outgoing webhooks carry a `traceparent` header, so a receiver that uses OpenTelemetry continues the same trace. A run's `trace_id` is in its JSON.

Secrets, tokens, page content and search results are never exported. For webhook URLs only the host is recorded.

## Differences from Perplexity's API

Same endpoints, objects, validation limits and error types. What differs:

- No credits, quotas, organization policies or rate limits, so `402`, `403` and `429` responses and the `insufficient_credits` and `org_policy` pause reasons never occur.
- `usage.cost` is 0 unless you set the two `COST_PER_*` rates.
- Schedules run without jitter.
- The `freshness` filter is stored and returned, but search providers do not tell published from updated dates. Results dated before the run window are dropped, undated ones are kept.
- Extra: `trace_id` on runs, `GET /v1/monitors/{id}/deliveries`, `POST /tick`, `GET /health`, and the dashboard.

## Not tested

Built and covered by automated tests against fake services, but never run against the real thing:

- Tavily, OpenRouter and other hosted LLM APIs
- `claude -p`, `codex exec` and `opencode run` as `LLM_COMMAND` (the mechanism is tested with shell commands)
- Kitesurf, Cloudflare Browser Run and Chrome as `BROWSER_WS_URL` (Lightpanda is tested)
- `BROWSER_WS_HEADERS`
- The Docker image and compose file
- A real Cloudflare deployment (it runs under `wrangler dev`)
- A real OTLP backend such as Grafana Cloud

## Development

```bash
npm test
```

The tests need no network. To include the browser rendering test, point it at a running CDP browser and a page whose content is produced by JavaScript:

```bash
TEST_BROWSER_WS_URL=ws://127.0.0.1:9222/ TEST_JS_PAGE_URL=http://127.0.0.1:8801/index.html npm test
```

## License

MIT, see [LICENSE](LICENSE).
