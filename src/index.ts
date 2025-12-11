import { LabelerServer } from "@skyware/labeler";
// import { Bot } from "@skyware/bot";
import { BskyAgent } from "@atproto/api";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
import express from "express";
import auth from "basic-auth";

dotenv.config();

const LABELER_DID = process.env.LABELER_DID!;
const SIGNING_KEY = process.env.SIGNING_KEY!;
const PORT = parseInt(process.env.PORT || "14831");
const BSKY_HANDLE = process.env.BSKY_HANDLE!;
const BSKY_PASSWORD = process.env.BSKY_PASSWORD!;

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3000");
const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "password";

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
// const bot = new Bot();

// Initialize BskyAgent for fetching followers
const agent = new BskyAgent({ service: "https://bsky.social" });

// Cache to prevent redundant processing
const processedUsers = new Set<string>();
const processedFollowers = new Set<string>();
const followerSources = new Map<string, Set<string>>();

// Store profile info for UI
interface ProfileInfo {
  did: string;
  handle: string;
  avatar?: string;
}
const profileCache = new Map<string, ProfileInfo>();

let isProcessing = false;

// Persistence

// We add the cache because always feching those fucking followers are making my server explode.
const CACHE_FILE = "cache.json";

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      if (Array.isArray(data.users)) data.users.forEach((u: string) => processedUsers.add(u));
      if (Array.isArray(data.followers)) data.followers.forEach((f: string) => processedFollowers.add(f));
      if (Array.isArray(data.profiles)) {
        data.profiles.forEach((p: ProfileInfo) => profileCache.set(p.did, p));
      }
      if (data.sources) {
        Object.entries(data.sources).forEach(([fDid, sources]: [string, any]) => {
            followerSources.set(fDid, new Set(sources));
        });
      }
      console.log(`Loaded cache: ${processedUsers.size} users, ${processedFollowers.size} followers, ${profileCache.size} profiles.`);
    }
  } catch (e) {
    console.error("Failed to load cache:", e);
  }
}

function saveCache() {
  try {
    const sourcesObj: Record<string, string[]> = {};
    followerSources.forEach((set, key) => {
        sourcesObj[key] = Array.from(set);
    });

    fs.writeFileSync(CACHE_FILE, JSON.stringify({
      users: Array.from(processedUsers),
      followers: Array.from(processedFollowers),
      profiles: Array.from(profileCache.values()),
      sources: sourcesObj
    }));
  } catch (e) {
    console.error("Failed to save cache:", e);
  }
}

// Save cache periodically (every 30s)
setInterval(saveCache, 30000);

async function resolveHandle(handleOrDid: string, agent: BskyAgent): Promise<string | null> {
  let identifier = handleOrDid.trim();
  if (identifier.startsWith("@")) {
    identifier = identifier.substring(1);
  }
  if (identifier.startsWith("did:")) {
    // If we have it in cache, return it, but we might want to fetch profile if missing
    if (profileCache.has(identifier)) return identifier;
    // If not in cache, we should try to fetch profile to get handle/avatar
    try {
        const res = await agent.getProfile({ actor: identifier });
        profileCache.set(identifier, {
            did: identifier,
            handle: res.data.handle,
            avatar: res.data.avatar
        });
        return identifier;
    } catch (e) {
        // If fetch fails, just return DID
        return identifier;
    }
  }
  
  try {
    const res = await agent.resolveHandle({ handle: identifier });
    const did = res.data.did;
    
    // Fetch profile to get avatar
    try {
        const profile = await agent.getProfile({ actor: did });
        profileCache.set(did, {
            did: did,
            handle: profile.data.handle,
            avatar: profile.data.avatar
        });
    } catch (e) {
        // If profile fetch fails, store what we know
        // Bad implementation but whatever i don't fucking care
        profileCache.set(did, { did, handle: identifier });
    }

    return did;
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
      
      res.data.followers.forEach((f: any) => {
        followers.push(f.did);
        // Cache profile info for followers too,
        // I KNOW THIS IS MEMORY INTENSIVE BUT I LIKE MY DASHBOARD FANCY OKAY
        profileCache.set(f.did, {
            did: f.did,
            handle: f.handle,
            avatar: f.avatar
        });
      });
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
                        // Track source
                        if (!followerSources.has(fDid)) {
                            followerSources.set(fDid, new Set());
                        }
                        followerSources.get(fDid)!.add(did);

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

function startDashboard() {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(process.cwd(), 'public')));

  // Basic Auth Middleware
  app.use((req, res, next) => {
    const user = auth(req);
    if (!user || user.name !== DASHBOARD_USER || user.pass !== DASHBOARD_PASS) {
      res.set("WWW-Authenticate", 'Basic realm="Niko Labeler Dashboard"');
      return res.status(401).send("Authentication required.");
    }
    next();
  });

  app.post("/add-user", (req, res) => {
    const { category, handle } = req.body;
    if (!category || !handle) return res.redirect("/");

    try {
      const content = fs.readFileSync(USERS_FILE, "utf-8");
      const config: UserList = JSON.parse(content);
      
      if (category === "artist") {
        if (!config.artists) config.artists = [];
        if (!config.artists.includes(handle)) config.artists.push(handle);
      } else if (category === "engager") {
        if (!config.engagers) config.engagers = [];
        if (!config.engagers.includes(handle)) config.engagers.push(handle);
      }

      fs.writeFileSync(USERS_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
      console.error("Failed to update users file:", e);
    }
    res.redirect("/");
  });

  app.get("/api/stats", (req, res) => {
    res.json({
      isProcessing,
      processedUsers: processedUsers.size,
      processedFollowers: processedFollowers.size
    });
  });

  app.get("/api/users", (req, res) => {
    let usersConfig: UserList = { artists: [], engagers: [] };
    try {
      const content = fs.readFileSync(USERS_FILE, "utf-8");
      usersConfig = JSON.parse(content);
    } catch (e) { }

    // Enrich with profile info
    const enrich = (list: string[]) => list.map(u => {
        // u might be handle or did
        // We need to find the DID first if u is handle, but we might not have it easily if not resolved yet.
        // However, resolveHandle populates the cache.
        // We can search the cache for a matching handle or DID.
        let info: ProfileInfo | undefined;
        
        // Try direct DID match
        if (profileCache.has(u)) {
            info = profileCache.get(u);
        } else {
            // Try finding by handle
            for (const p of profileCache.values()) {
                if (p.handle === u || p.handle === u.replace("@", "")) {
                    info = p;
                    break;
                }
            }
        }
        
        return {
            input: u,
            did: info?.did || u, // Fallback to input if unknown
            handle: info?.handle || u,
            avatar: info?.avatar
        };
    });

    res.json({
        artists: enrich(usersConfig.artists || []),
        engagers: enrich(usersConfig.engagers || [])
    });
  });

  app.get("/api/followers", (req, res) => {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 50;
      const search = (req.query.search as string || "").toLowerCase();

      let allFollowers = Array.from(processedFollowers).map(did => {
          const info = profileCache.get(did);
          const sources = Array.from(followerSources.get(did) || []).map(sourceDid => {
              const sourceInfo = profileCache.get(sourceDid);
              return sourceInfo?.handle || sourceDid;
          });

          return {
              did,
              handle: info?.handle || did,
              avatar: info?.avatar,
              following: sources
          };
      });

      if (search) {
          allFollowers = allFollowers.filter(f => 
              f.did.toLowerCase().includes(search) || 
              f.handle.toLowerCase().includes(search)
          );
      }

      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;
      const results = allFollowers.slice(startIndex, endIndex);

      res.json({
          items: results,
          total: allFollowers.length,
          hasMore: endIndex < allFollowers.length
      });
  });

  // Debug: return labeler service record (if present)
  app.get('/api/labeler-service', async (req, res) => {
    try {
      const records = await agent.com.atproto.repo.listRecords({
        repo: LABELER_DID,
        collection: 'app.bsky.labeler.service',
      });
      if (!records.data || !records.data.records) return res.json({ found: false });
      const rec = records.data.records[0];
      return res.json({ found: true, uri: rec.uri, value: rec.value });
    } catch (err: any) {
      return res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.get("/", (req, res) => {
      res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });
  
  app.get("/followers", (req, res) => {
      res.sendFile(path.join(process.cwd(), 'public', 'followers.html'));
  });

  app.listen(DASHBOARD_PORT, () => {
    console.log(`Dashboard running on http://localhost:${DASHBOARD_PORT}`);
  });
}

async function main() {
  // Start Dashboard
  startDashboard();

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
    /*
    await bot.login({
      identifier: BSKY_HANDLE,
      password: BSKY_PASSWORD,
    });
    console.log("Bot logged in.");
    */

    await agent.login({
      identifier: BSKY_HANDLE,
      password: BSKY_PASSWORD,
    });
    console.log("Agent logged in.");
    
    // Load cache after login (or before, doesn't matter much, but good to have context)
    loadCache();

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

  // Start Dashboard
  startDashboard();
}

main();
