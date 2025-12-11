import { LabelerServer } from "@skyware/labeler";
import { Bot } from "@skyware/bot";
import { BskyAgent } from "@atproto/api";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

dotenv.config();

const LABELER_DID = process.env.LABELER_DID!;
const SIGNING_KEY = process.env.SIGNING_KEY!;
const PORT = parseInt(process.env.PORT || "14831");
const BSKY_HANDLE = process.env.BSKY_HANDLE!;
const BSKY_PASSWORD = process.env.BSKY_PASSWORD!;

// Configuration
const USERS_FILE = "users.json";
const LABEL_ARTIST = "explicit-niko-artist";
const LABEL_ENGAGER = "engages-explicit-niko";
const LABEL_FOLLOWER = "follows-explicit-niko";

interface UserList {
  artists: string[];
  engagers: string[];
}

// Initialize Labeler Server
const server = new LabelerServer({
  did: LABELER_DID,
  signingKey: SIGNING_KEY,
});

// Initialize Bot for API requests (if needed for other things)
const bot = new Bot();

// Initialize BskyAgent for fetching followers
const agent = new BskyAgent({ service: "https://bsky.social" });

// Cache to prevent redundant processing
const processedUsers = new Set<string>();
const processedFollowers = new Set<string>();
let isProcessing = false;

async function resolveHandle(handleOrDid: string, agent: BskyAgent): Promise<string | null> {
  let identifier = handleOrDid.trim();
  if (identifier.startsWith("@")) {
    identifier = identifier.substring(1);
  }
  if (identifier.startsWith("did:")) return identifier;
  
  try {
    const res = await agent.resolveHandle({ handle: identifier });
    return res.data.did;
  } catch (e) {
    console.error(`Failed to resolve handle ${handleOrDid}:`, e);
    return null;
  }
}

async function fetchFollowers(did: string, agent: BskyAgent) {
  let cursor: string | undefined;
  const followers: string[] = [];
  
  try {
    do {
      const res = await agent.app.bsky.graph.getFollowers({
        actor: did,
        limit: 100,
        cursor,
      });
      
      res.data.followers.forEach((f: any) => followers.push(f.did));
      cursor = res.data.cursor;
    } while (cursor);
  } catch (e) {
    console.error(`Error fetching followers for ${did}:`, e);
  }
  
  return followers;
}

async function labelUser(did: string, label: string) {
  try {
    await server.createLabel({
      uri: did,
      val: label,
    });
    // console.log(`Labeled ${did} as ${label}`);
  } catch (e) {
    console.error(`Failed to label ${did}:`, e);
  }
}

async function processList() {
  if (isProcessing) {
    console.log("Already processing, skipping...");
    return;
  }
  isProcessing = true;
  console.log("Processing users list...");
  
  // Use Bun's fast file reading if available, otherwise fs
  let content = "";
  try {
    // @ts-ignore
    if (typeof Bun !== "undefined") {
        // @ts-ignore
        content = await Bun.file(USERS_FILE).text();
    } else {
        content = fs.readFileSync(USERS_FILE, "utf-8");
    }
  } catch (e) {
    console.error("Error reading users file:", e);
    isProcessing = false;
    return;
  }

  let data: UserList;
  try {
    data = JSON.parse(content);
  } catch (e) {
    console.error("Error parsing JSON:", e);
    isProcessing = false;
    return;
  }

  const CHUNK_SIZE = 5;
  
  try {
    // Process Artists
    if (data.artists && Array.isArray(data.artists)) {
        console.log(`Processing ${data.artists.length} artists...`);
        for (let i = 0; i < data.artists.length; i += CHUNK_SIZE) {
            const chunk = data.artists.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (userEntry) => {
                const did = await resolveHandle(userEntry, agent);
                if (!did) return;

                // Label the artist
                if (!processedUsers.has(did + LABEL_ARTIST)) {
                    await labelUser(did, LABEL_ARTIST);
                    processedUsers.add(did + LABEL_ARTIST);
                    console.log(`Labeled artist: ${did}`);
                }

                // Fetch and label followers
                const followers = await fetchFollowers(did, agent);
                console.log(`Found ${followers.length} followers for artist ${did}`);

                const followerChunkSize = 20;
                for (let j = 0; j < followers.length; j += followerChunkSize) {
                    const fChunk = followers.slice(j, j + followerChunkSize);
                    await Promise.all(fChunk.map(async (fDid) => {
                        if (!processedFollowers.has(fDid)) {
                            await labelUser(fDid, LABEL_FOLLOWER);
                            processedFollowers.add(fDid);
                        }
                    }));
                }
            }));
        }
    }

    // Process Engagers
    if (data.engagers && Array.isArray(data.engagers)) {
        console.log(`Processing ${data.engagers.length} engagers...`);
        for (let i = 0; i < data.engagers.length; i += CHUNK_SIZE) {
            const chunk = data.engagers.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (userEntry) => {
                const did = await resolveHandle(userEntry, agent);
                if (!did) return;

                // Label the engager
                if (!processedUsers.has(did + LABEL_ENGAGER)) {
                    await labelUser(did, LABEL_ENGAGER);
                    processedUsers.add(did + LABEL_ENGAGER);
                    console.log(`Labeled engager: ${did}`);
                }
            }));
        }
    }

  } finally {
    isProcessing = false;
    console.log("Finished processing list.");
  }
}

async function main() {
  // Start Labeler Server
  server.start(PORT, (error: any) => {
    if (error) {
      console.error("Failed to start labeler server:", error);
    } else {
      console.log(`Labeler server running on port ${PORT}`);
    }
  });

  // Login Bot and Agent
  try {
    await bot.login({
      identifier: BSKY_HANDLE,
      password: BSKY_PASSWORD,
    });
    console.log("Bot logged in.");

    await agent.login({
      identifier: BSKY_HANDLE,
      password: BSKY_PASSWORD,
    });
    console.log("Agent logged in.");
  } catch (e) {
    console.error("Failed to login:", e);
    process.exit(1);
  }

  // Initial process
  await processList();

  // Watch for file changes
  console.log(`Watching ${USERS_FILE} for changes...`);
  
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  fs.watch(USERS_FILE, (eventType, filename) => {
    if (eventType === "change") {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("File changed, reprocessing...");
        processList();
      }, 1000); // Debounce 1s
    }
  });
}

main();
