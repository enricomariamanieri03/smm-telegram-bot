# Giuseppe Manieri Autoservizi — SMM Telegram Bot

A production-oriented Telegram bot that turns photos and short user prompts into social-media posts for **Giuseppe Manieri Autoservizi**. It generates an editable preview with OpenAI, then publishes approved content to Facebook, Instagram, or both platforms.

The project focuses on reliable asynchronous workflows: media albums, temporary hosting, API polling, retry-safe cross-platform publishing, chat cleanup, and testable in-memory state.

## Highlights

- Generates structured social copy from Telegram photos and a user caption with OpenAI Vision.
- Enforces a strict JSON Schema for predictable AI output: destination, location, and post caption.
- Collects Telegram albums with an in-memory `Map` and debounce before one multimodal AI request.
- Supports Facebook single-image posts and multi-photo posts through the Meta Graph API.
- Supports Instagram single-image posts and carousels through Cloudinary temporary hosting and the Instagram Graph API.
- Provides an interactive Telegram workflow: **Approve**, **Edit text**, **Reject**, and one controlled cross-platform retry.
- Uses TTL-managed preview sessions, duplicate-click protection, defensive validation, network timeouts, polling, and best-effort cleanup.
- Includes unit and integration tests with Vitest and fully mocked external services.

## Architecture at a glance

```text
Telegram photo(s)
      │
      ▼
photo.handler ──► Album buffer / debounce ──► OpenAI service
      │                                           │
      ▼                                           ▼
Telegram preview ◄──────────────────── structured social post
      │
      ├── Approve ─► Facebook / Cloudinary + Instagram
      ├── Edit ────► OpenAI copy regeneration ─► updated preview
      └── Reject ──► delayed Telegram cleanup
```

See [the architecture guide](docs/ARCHITECTURE.md) for the full workflow, state model, error handling, and testing strategy.

## Demo

<p align="center">
  <a href="https://drive.google.com/file/d/1ppqGexO6NCCmsfqi3913LNdhvlcewA6p/view?usp=drive_link">
    <img
      src="docs/assets/telegram-demo-preview.png"
      alt="Telegram workflow showing an AI-generated social-post preview and its actions"
      width="360"
    />
  </a>
</p>

<p align="center"><em>Click the preview to watch the complete Telegram workflow demo.</em></p>

## Tech stack

- **Runtime:** Node.js, TypeScript, native ESM
- **Telegram:** [grammY](https://grammy.dev/)
- **AI:** OpenAI Node SDK with structured JSON Schema output
- **Publishing:** Meta Graph API for Facebook Pages and Instagram professional accounts
- **Temporary media hosting:** Cloudinary
- **Tests:** Vitest

## Prerequisites

- Node.js 20+
- A Telegram bot token and at least one allowed Telegram user ID
- An OpenAI API key and a vision-capable model configured in `OPENAI_MODEL`
- A Facebook Page, an Instagram professional account connected to it, and the required Meta permissions
- A Cloudinary account for Instagram temporary media hosting

## Configuration

Create a local `.env` file. It is intentionally ignored by Git; never commit tokens or secrets.

| Variable | Required | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram Bot API token |
| `ALLOWED_USERS` | Yes | Comma-separated Telegram user IDs allowed to use the bot |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `OPENAI_MODEL` | Yes | Vision-capable model used for copy generation |
| `META_ACCESS_TOKEN` | Yes | Meta access token with Page and Instagram publishing permissions |
| `FB_PAGE_ID` | Yes | Facebook Page ID |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | Yes | Instagram professional account ID |
| `CLOUDINARY_CLOUD_NAME` | Yes | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes | Cloudinary API secret |
| `FB_GRAPH_API_VERSION` | No | Facebook Graph API version override |
| `IG_GRAPH_API_VERSION` | No | Instagram Graph API version override; falls back to Facebook version/default |
| `CLOUDINARY_INSTAGRAM_FOLDER` | No | Folder for temporary Instagram assets |

## Run locally

```bash
npm install
npm run dev
```

The application uses Telegram long polling and removes a previously configured webhook on startup.

## Quality checks

```bash
# TypeScript production build
npm run build

# Entire test suite
npm test

# Watch mode while developing tests
npm run test:watch
```

The current suite contains unit tests for publishing, cleanup, and state services, plus integration tests for the Telegram Approve, Edit, and Reject workflows.

## Project structure

```text
src/
├── handlers/       # Telegram update and callback workflows
├── services/       # OpenAI, Meta, Cloudinary, preview, and in-memory state
├── types/          # Domain interfaces and enums
└── main.ts         # Bot configuration, auth middleware, routes, and startup

tests/
├── unit/           # Service-level tests
└── integration/    # Handler workflows with mocked Telegram and external APIs

docs/
└── ARCHITECTURE.md # Detailed technical design
```

## Notes on production use

The preview and editing session state is intentionally in memory. It is a good fit for a single Node.js process; a horizontally scaled deployment should replace it with a shared store such as Redis. Refer to the architecture guide for the reasoning and operational trade-offs.
