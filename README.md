# Niko Explicit Artist Bluesky Labeler

This is a high-performance Bluesky Labeler built with Node.js/Bun, `@skyware/labeler`, and `@skyware/bot`.

It monitors a JSON file (`users.json`) and automatically labels users based on categories, including their followers.

## Categories

1.  **Explicit Niko Artist** (`explicit-niko-artist`)
    - "An account that regularly creates or shares explicit or sexually suggestive Niko (OneShot) artwork."
    - **Followers of these artists** are automatically labeled as `follows-explicit-niko`.

2.  **Engages With Explicit Niko Content** (`engages-explicit-niko`)
    - "An account that frequently interacts (likes, reposts or comments) with explicit or sexually suggestive Niko (OneShot) artwork or its creators."

## Prerequisites

- [Bun](https://bun.sh/) or Node.js
- A Bluesky account to act as the labeler
- A domain and SSL certificate (for the labeler service)

## Setup

1.  **Install Dependencies:**
    ```bash
    bun install
    # or
    npm install
    ```

2.  **Configure Environment:**
    Edit `.env` with your credentials:
    ```env
    LABELER_DID=did:plc:your_labeler_did
    SIGNING_KEY=your_signing_key
    BSKY_HANDLE=your_handle
    BSKY_PASSWORD=your_app_password
    PORT=14831
    ```

3.  **Define Labels:**
    You can automatically add the required labels by running the included setup script:
    ```bash
    bun run setup-labels
    # or
    npm run setup-labels
    ```
    This will add the following labels to your labeler:
    - `explicit-niko-artist`
    - `engages-explicit-niko`
    - `follows-explicit-niko`

4.  **Add Users:**
    Edit `users.json` with the DIDs or Handles (e.g., `@username.bsky.social`):
    ```json
    {
      "artists": [
        "did:plc:exampleexamplexample",
        "@example.com"
      ],
      "engagers": [
        "@another-user.bsky.social"
      ]
    }
    ```

## Running

To run with Bun (fastest):
```bash
bun run start
```

To run with Node:
```bash
npm start
```

## Dashboard

A secure web dashboard is available to monitor the labeler status.

-   **URL:** `http://localhost:3000` (default)
-   **Credentials:** Configured in `.env` (Default: `admin` / `password`)

The dashboard shows:
-   Current status (Idle/Processing)
-   Number of processed users and followers in the current session
-   The current list of Artists and Engagers from `users.json`

## Features

-   **Dynamic Updates:** Edit `users.json` while the script is running, and it will automatically pick up changes.
- **Follower Labeling:** Automatically fetches and labels all followers of the "Artist" category.
- **Parallel Processing:** Uses concurrent requests to fetch and label data as fast as possible.
- **Caching:** Remembers processed users to avoid redundant API calls in the same session.
