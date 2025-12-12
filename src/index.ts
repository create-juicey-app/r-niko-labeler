import { LabelerServer } from "@skyware/labeler";
import { BskyAgent } from "@atproto/api";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
import express from "express";
import auth from "basic-auth";
import net from 'net';
import http from 'http';

dotenv.config();

const LABELER_DID = process.env.LABELER_DID!;
const SIGNING_KEY = process.env.SIGNING_KEY!;
const PORT = parseInt(process.env.PORT || "14831");
const BSKY_HANDLE = process.env.BSKY_HANDLE!;
const BSKY_PASSWORD = process.env.BSKY_PASSWORD!;

const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || "3000");
const DASHBOARD_USER = process.env.DASHBOARD_USER || "admin";
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || "password";
const PROXY_PORT = parseInt(process.env.PROXY_PORT || "14832");

 
const USERS_FILE = "users.json";
const LABEL_ARTIST = "explicit-niko-artist";
const LABEL_ENGAGER = "engages-explicit-niko";
const LABEL_FOLLOWER = "follows-explicit-niko";

interface UserList {
  artists: string[];
  engagers: string[];
}

 
const server = new LabelerServer({
  did: LABELER_DID,
  signingKey: SIGNING_KEY,
});

 

 
const agent = new BskyAgent({ service: "https://bsky.social" });

 
const processedUsers = new Set<string>();
const processedFollowers = new Set<string>();
const followerSources = new Map<string, Set<string>>();

 
interface ProfileInfo {
  did: string;
  handle: string;
  avatar?: string;
}
const profileCache = new Map<string, ProfileInfo>();

let isProcessing = false;

 

 
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

setInterval(saveCache, 30000);

async function resolveHandle(handleOrDid: string, agent: BskyAgent): Promise<string | null> {
  let identifier = handleOrDid.trim();
  if (identifier.startsWith("@")) {
    identifier = identifier.substring(1);
  }
  if (identifier.startsWith("did:")) {
    
    if (profileCache.has(identifier)) return identifier;
    
    try {
        const res = await agent.getProfile({ actor: identifier });
        profileCache.set(identifier, {
            did: identifier,
            handle: res.data.handle,
            avatar: res.data.avatar
        });
        return identifier;
    } catch (e) {
        
        return identifier;
    }
  }
  
  try {
    const res = await agent.resolveHandle({ handle: identifier });
    const did = res.data.did;
    
    
    try {
        const profile = await agent.getProfile({ actor: did });
        profileCache.set(did, {
            did: did,
            handle: profile.data.handle,
            avatar: profile.data.avatar
        });
    } catch (e) {
        
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
  
  
  let content = "";
  try {
  if (typeof Bun !== "undefined") {
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
    
    if (data.artists && Array.isArray(data.artists)) {
        console.log(`Processing ${data.artists.length} artists...`);
        for (let i = 0; i < data.artists.length; i += CHUNK_SIZE) {
            const chunk = data.artists.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (userEntry) => {
                const did = await resolveHandle(userEntry, agent);
                if (!did) return;

                
                if (!processedUsers.has(did + LABEL_ARTIST)) {
                    await labelUser(did, LABEL_ARTIST);
                    processedUsers.add(did + LABEL_ARTIST);
                    console.log(`Labeled artist: ${did}`);
                }

                
                const followers = await fetchFollowers(did, agent);
                console.log(`Found ${followers.length} followers for artist ${did}`);

                const followerChunkSize = 20;
                for (let j = 0; j < followers.length; j += followerChunkSize) {
                    const fChunk = followers.slice(j, j + followerChunkSize);
                    await Promise.all(fChunk.map(async (fDid) => {
                        
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

    
    if (data.engagers && Array.isArray(data.engagers)) {
        console.log(`Processing ${data.engagers.length} engagers...`);
        for (let i = 0; i < data.engagers.length; i += CHUNK_SIZE) {
            const chunk = data.engagers.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (userEntry) => {
                const did = await resolveHandle(userEntry, agent);
                if (!did) return;

                
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

  
  app.use((req, res, next) => {
    
    if (req.path.startsWith('/api')) return next();

    const user = auth(req);
    if (!user || user.name !== DASHBOARD_USER || user.pass !== DASHBOARD_PASS) {
      res.set("WWW-Authenticate", 'Basic realm="Niko Labeler Dashboard"');
      return res.status(401).send("Authentication required.");
    }
    next();
  });

  app.use(express.static(path.join(process.cwd(), 'public')));

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

  app.post("/api/reprocess", async (req, res) => {
    if (isProcessing) return res.status(409).send("Already processing");
    
    
    processedUsers.clear();
    processedFollowers.clear();
    
    processList().catch(console.error);
    res.send("Reprocessing started");
  });

  app.get("/api/stats", (req, res) => {
    res.json({
      isProcessing,
      processedUsers: processedUsers.size,
      processedFollowers: processedFollowers.size
    });
  });

  app.post("/api/reprocess", async (req, res) => {
    if (isProcessing) return res.status(409).send("Already processing");
    
    
    
    processedUsers.clear();
    processedFollowers.clear();
    
    
    
    processList().catch(console.error);
    res.send("Reprocessing started");
  });

  app.get("/api/users", (req, res) => {
    let usersConfig: UserList = { artists: [], engagers: [] };
    try {
      const content = fs.readFileSync(USERS_FILE, "utf-8");
      usersConfig = JSON.parse(content);
    } catch (e) { }

    
    const enrich = (list: string[]) => list.map(u => {
        
        
        
        
        let info: ProfileInfo | undefined;
        
        
        if (profileCache.has(u)) {
            info = profileCache.get(u);
        } else {
            
            for (const p of profileCache.values()) {
                if (p.handle === u || p.handle === u.replace("@", "")) {
                    info = p;
                    break;
                }
            }
        }
        
        return {
            input: u,
            did: info?.did || u,
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
  
  startDashboard();

  
  const startFn = (server as any).start;
  const startCb = (error: any) => {
    if (error) {
      console.error("Failed to start labeler server:", error);
    } else {
      console.log(`Labeler server running on port ${PORT}`);
    }
  };

  // If the start function supports a host argument, call the 3-arg signature
  // to ensure the server binds to 0.0.0.0 (not just localhost) so reverse
  // proxies on the same host can route traffic to it reliably.
  if (typeof startFn === 'function' && (startFn.length ?? 0) >= 3) {
    (server as any).start(PORT, '0.0.0.0', startCb);
  } else {
    server.start(PORT, startCb);
  }

  
  const DISABLE_INTERNAL_PROXY = (process.env.DISABLE_INTERNAL_PROXY || '').toLowerCase() === '1' || (process.env.DISABLE_INTERNAL_PROXY || '').toLowerCase() === 'true';
  if (DISABLE_INTERNAL_PROXY) {
    console.log('DISABLE_INTERNAL_PROXY is set — skipping internal HTTP proxy startup. Use an external reverse proxy to route dashboard and labeler endpoints.');
  } else {
  try {
    const httpProxy = http.createServer((req, res) => {
      try {
        const url = req.url || '/';
        
        const pathOnly = url.replace(/^https?:\/\/[^\/]+/, '');

        
        const routeToDashboard = pathOnly.startsWith('/api') || pathOnly === '/' || pathOnly.startsWith('/followers') || pathOnly.startsWith('/static') || pathOnly.startsWith('/public');

        const targetPort = routeToDashboard ? DASHBOARD_PORT : PORT;
        console.log(`Proxy: ${req.method} ${url} (path: ${pathOnly}) -> :${targetPort}`);

        const options = {
          hostname: '127.0.0.1',
          port: targetPort,
          path: url,
          method: req.method,
          headers: req.headers,
        } as http.RequestOptions;

        const proxyReq = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers as http.IncomingHttpHeaders);
          proxyRes.pipe(res, { end: true });
        });

        proxyReq.on('error', (err) => {
          console.error('Proxy request error:', err);
          res.statusCode = 502;
          res.end('Bad gateway');
        });

        req.pipe(proxyReq, { end: true });
      } catch (err) {
        console.error('HTTP proxy handler error:', err);
        res.statusCode = 500;
        res.end('Internal proxy error');
      }
    });

    httpProxy.on('upgrade', (req, socket, head) => {
      const targetPort = PORT;
      console.log(`Proxy Upgrade: ${req.url} -> :${targetPort}`);

      const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
        
        proxySocket.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
        
        const allowedHeaders = new Set([
          'host',
          'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol',
          'origin', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host'
        ]);

        for (const [name, value] of Object.entries(req.headers)) {
          const lname = name.toLowerCase();
          if (!allowedHeaders.has(lname)) continue;
          
          if (Array.isArray(value)) {
            value.forEach(v => proxySocket.write(`${name}: ${v}\r\n`));
          } else if (value !== undefined) {
            proxySocket.write(`${name}: ${value}\r\n`);
          }
        }
  
  proxySocket.write(`Host: 127.0.0.1:${targetPort}\r\n`);
  proxySocket.write('Upgrade: websocket\r\n');
  proxySocket.write('Connection: Upgrade\r\n');
  
  console.log('Proxying WS handshake ->', req.method, req.url, 'Host:', `127.0.0.1:${targetPort}`);
        proxySocket.write('\r\n');
        proxySocket.write(head);
        
        proxySocket.on('data', (chunk) => {
          
          console.log(`proxySocket data (${chunk.length} bytes):`, chunk.slice(0, 16));
        });
        proxySocket.on('error', (err) => {
          console.error('Proxy socket to backend error:', err);
        });
        proxySocket.on('close', (hadError) => {
          console.log('Proxy socket to backend closed, hadError=', hadError);
        });
        
  proxySocket.setNoDelay(true);
  const clientSocket = socket as net.Socket;
  clientSocket.setNoDelay(true);
  try { socket.resume(); } catch (e) { }

        
        socket.pipe(proxySocket, { end: false });
        let handshakeWritten = false;
        proxySocket.once('data', (chunk) => {
          handshakeWritten = true;
          console.log('Forwarding initial backend handshake chunk to client', chunk.slice(0, 64));
          clientSocket.write(chunk);
          
          proxySocket.pipe(clientSocket, { end: false });
        });
        
        setTimeout(() => {
          if (!handshakeWritten) {
            console.log('No initial handshake received; starting pipe anyway');
            proxySocket.pipe(clientSocket, { end: false });
          }
        }, 2000);

        
        clientSocket.on('data', (chunk) => {
          console.log(`clientSocket data (${chunk.length} bytes)`);
        });
        clientSocket.on('error', (err) => {
          console.error('Client socket error (upgrade):', err);
        });
        clientSocket.on('close', (hadError: boolean) => {
          console.log('Client socket closed (upgrade), hadError=', hadError);
        });
      });

      proxySocket.on('error', (err) => {
        console.error('Proxy socket error:', err);
        socket.end();
      });

      socket.on('error', (err) => {
        console.error('Client socket error:', err);
        proxySocket.end();
      });
    });

    httpProxy.on('error', (e) => console.error('HTTP proxy error:', e));
    httpProxy.listen(PROXY_PORT, '0.0.0.0', () => {
      console.log(`HTTP proxy listening on 0.0.0.0:${PROXY_PORT} -> dashboard:${DASHBOARD_PORT} / labeler:${PORT}`);
    });
    } catch (e) {
      console.error('Failed to start HTTP proxy:', e);
    }
  }

  
  try {
    await agent.login({
      identifier: BSKY_HANDLE,
      password: BSKY_PASSWORD,
    });
    console.log("Agent logged in.");
    
    
    loadCache();

  } catch (e) {
    console.error("Failed to login:", e);
    process.exit(1);
  }

  
  await processList();

  
  console.log(`Watching ${USERS_FILE} for changes...`);
  
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  fs.watch(USERS_FILE, (eventType, filename) => {
    if (eventType === "change") {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("File changed, reprocessing...");
        processList();
  }, 1000);
    }
  });
}

main();
